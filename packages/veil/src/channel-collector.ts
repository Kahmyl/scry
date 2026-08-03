import type { PrivacyCollector, PrivacyPreparation } from "./runtime-coordinator.js";
import type { PrivacyFailure, SafeResumeBoundary } from "@scry/contracts";

export type VeilChannelCollectorState =
  "active" | "prepared" | "suspended" | "isolated" | "sealed" | "finalized";

/**
 * A synchronous capture fence for collectors whose capture hooks live in the
 * executor. The transition promise resolves only after the fence is visible to
 * those hooks, so an acknowledgement is proof of real suppression state.
 */
export class VeilChannelCollector implements PrivacyCollector {
  private current: VeilChannelCollectorState = "active";
  private activeOperationId: string | undefined;
  private revision = 0;

  constructor(readonly name: string) {}

  state(): Readonly<{ status: VeilChannelCollectorState; operationId?: string; revision: number }> {
    return Object.freeze({
      status: this.current,
      ...(this.activeOperationId ? { operationId: this.activeOperationId } : {}),
      revision: this.revision,
    });
  }

  isCaptureSuppressed(): boolean {
    return this.current !== "active";
  }

  async arm(operationId: string, _preparation?: PrivacyPreparation): Promise<void> {
    if (this.current !== "active") throw new Error(`VEIL_COLLECTOR_NOT_ACTIVE:${this.name}`);
    this.activeOperationId = operationId;
    this.current = "prepared";
    this.revision += 1;
  }

  async suspend(): Promise<void> {
    if (this.current !== "prepared") throw new Error(`VEIL_COLLECTOR_NOT_PREPARED:${this.name}`);
    this.current = "suspended";
    this.revision += 1;
  }

  async isolate(): Promise<void> {
    if (this.current !== "suspended") throw new Error(`VEIL_COLLECTOR_NOT_SUSPENDED:${this.name}`);
    this.current = "isolated";
    this.revision += 1;
  }

  async resume(_boundary: SafeResumeBoundary): Promise<void> {
    if (this.current !== "isolated") throw new Error(`VEIL_COLLECTOR_NOT_ISOLATED:${this.name}`);
    this.current = "active";
    this.activeOperationId = undefined;
    this.revision += 1;
  }

  async seal(_reason: PrivacyFailure): Promise<void> {
    if (this.current === "finalized") return;
    this.current = "sealed";
    this.revision += 1;
  }

  async finalize(): Promise<void> {
    this.current = "finalized";
    this.activeOperationId = undefined;
    this.revision += 1;
  }
}
