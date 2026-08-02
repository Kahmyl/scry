import { createHash } from "node:crypto";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { Checkpoint } from "@scry/contracts";

export type CheckpointPayload = Awaited<ReturnType<BrowserContext["storageState"]>>;
export type CheckpointStore = {
  establish(input: { checkpoint: Checkpoint; payload: CheckpointPayload; bindingFingerprint: string; expiresAt: string }): Promise<void>;
  claim(checkpointId: string): Promise<{ payload: CheckpointPayload; bindingFingerprint: string }>;
  complete(checkpointId: string, outcome: "verified" | "failed" | "destroyed", reasonCode?: string): Promise<void>;
};
export type RestoredRuntime = { context: BrowserContext; page: Page };

export class CheckpointCoordinator {
  constructor(private readonly input: { runId: string; flowRevisionId: string; environmentId: string; allowedOrigins: string[]; store: CheckpointStore }) {}
  async establish(context: BrowserContext, checkpoint: Checkpoint) {
    const payload = await context.storageState({ indexedDB: checkpoint.state.indexedDb });
    const bindingFingerprint = this.binding(checkpoint);
    await this.input.store.establish({ checkpoint, payload, bindingFingerprint, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
  }
  async restore(
    checkpoint: Checkpoint,
    uncertainContext: BrowserContext,
    createContext: (options: BrowserContextOptions) => Promise<RestoredRuntime>,
    verify: (page: Page, checkpoint: Checkpoint) => Promise<void>,
    lifecycle?: {
      contextDestroyed?: () => void | Promise<void>;
      restoring?: () => void | Promise<void>;
      verified?: () => void | Promise<void>;
    },
  ) {
    await uncertainContext.close();
    await lifecycle?.contextDestroyed?.();
    let restored: RestoredRuntime | undefined;
    try {
      const claimed = await this.input.store.claim(checkpoint.id);
      if (claimed.bindingFingerprint !== this.binding(checkpoint)) throw new Error("CHECKPOINT_BINDING_MISMATCH");
      await lifecycle?.restoring?.();
      restored = await createContext({ storageState: claimed.payload, serviceWorkers: "block", acceptDownloads: false });
      await restored.page.goto(checkpoint.restorationUrl, { waitUntil: "domcontentloaded" });
      if (!this.input.allowedOrigins.includes(new URL(restored.page.url()).origin)) throw new Error("CHECKPOINT_ORIGIN_MISMATCH");
      await verify(restored.page, checkpoint);
      await this.input.store.complete(checkpoint.id, "verified");
      await lifecycle?.verified?.();
      return restored;
    } catch (error) {
      await restored?.context.close().catch(() => undefined);
      await this.input.store.complete(checkpoint.id, "failed", safeCode(error)).catch(() => undefined);
      throw new CheckpointRestoreError(safeCode(error));
    }
  }
  private binding(checkpoint: Checkpoint) { return createHash("sha256").update(JSON.stringify({ runId: this.input.runId, flowRevisionId: this.input.flowRevisionId, environmentId: this.input.environmentId, allowedOrigins: [...this.input.allowedOrigins].sort(), checkpointId: checkpoint.id, restorationUrl: checkpoint.restorationUrl })).digest("hex"); }
}
export class CheckpointRestoreError extends Error { constructor(readonly code: string) { super(code); } }
function safeCode(error: unknown) { const value = error instanceof Error ? error.message : String(error); return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "CHECKPOINT_RESTORE_FAILED"; }
