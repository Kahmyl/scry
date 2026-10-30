import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserContext, Page, CDPSession } from "playwright";
import type { ChronicleNativeRecordingPort } from "@scry/contracts";

/** Records the live browser's native pixels. Screenshots are action checkpoints,
 * never the source of the video. Chronicle owns files and admitted receipts. */
export class SanitizedBrowserRecorder {
  readonly #pages = new Map<Page, { filename: string; started: number }>();
  readonly #contexts = new Set<BrowserContext>();
  readonly #attachments = new Set<Promise<void>>();
  readonly #privateWorlds = new Map<Page, CDPSession>();
  #closed = false;
  #queue: Promise<void> = Promise.resolve();
  #aborting?: Promise<void>;
  #closing?: Promise<void>;
  readonly #onPage = (page: Page) => {
    void this.attach(page).catch((error) =>
      this.options.native.recordError("recorder_attach_failed", error),
    );
  };
  constructor(
    private readonly options: { native: ChronicleNativeRecordingPort; protectionScript: string },
  ) {}

  async start(context: BrowserContext): Promise<void> {
    await Promise.resolve();
    this.assertOpen();
    if (this.#contexts.has(context)) return;
    this.#contexts.add(context);
    context.on("page", this.#onPage);
    for (const page of context.pages()) await this.attach(page);
  }

  private attach(page: Page): Promise<void> {
    const attached = this.attachPage(page);
    this.#attachments.add(attached);
    void attached.finally(() => this.#attachments.delete(attached)).catch(() => undefined);
    return attached;
  }

  private async attachPage(page: Page): Promise<void> {
    this.assertOpen();
    if (this.#pages.has(page)) return;
    const filename = `${randomUUID()}.webm`;
    const entry = { filename, started: Date.now() };
    this.#pages.set(page, entry);
    let session: CDPSession | undefined;
    try {
      session = await page.context().newCDPSession(page);
      this.assertOpen();
      this.#privateWorlds.set(page, session);
      // CDP does not install future-document scripts until the Page domain is
      // enabled on this session. A successful addScript reply alone is not proof.
      await session.send("Page.enable");
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: this.options.protectionScript,
        worldName: "scry-native-protection",
        runImmediately: true,
      });
    } catch (error) {
      this.#privateWorlds.delete(page);
      await session?.detach().catch(() => undefined);
      if (this.#closed) throw error;
      this.options.native.maskingUnavailable();
    }
    this.assertOpen();
    await page.screencast.start({
      path: path.join(this.options.native.directory, filename),
      size: page.viewportSize() ?? { width: 1280, height: 720 },
    });
    if (this.#closed && !page.isClosed()) await page.screencast.stop();
  }

  async protectValue(value: string): Promise<void> {
    for (const page of this.#pages.keys())
      if (!page.isClosed()) {
        await this.privateEvaluation(
          page,
          `globalThis.__scryNativeRefresh?.(${JSON.stringify(value)})`,
        ).catch(() => this.options.native.maskingUnavailable());
      }
  }

  checkpoint(label = "commit"): Promise<void> {
    this.assertOpen();
    const operation = this.#queue.then(async () => {
      if (this.#closed) return;
      for (const page of this.#pages.keys())
        if (!page.isClosed()) {
          const filename = `${randomUUID()}.png`;
          try {
            await this.privateEvaluation(
              page,
              "new Promise(resolve => { globalThis.__scryNativeRefresh?.(); setTimeout(resolve,100); requestAnimationFrame(() => requestAnimationFrame(resolve)); })",
            );
          } catch {
            this.options.native.maskingUnavailable();
          }
          try {
            if (this.#closed) return;
            await page.screenshot({
              path: path.join(this.options.native.directory, filename),
              timeout: 5000,
            });
          } catch {
            // Optional screenshot/mask failure does not invalidate native video or
            // the application journey. The viewer always warns about missed masks.
            continue;
          }
          if (this.#closed) return;
          await this.options.native.admit({
            filename,
            kind: "screenshot",
            timestamp: Date.now(),
            label,
          });
        }
    });
    this.#queue = operation.catch((error) =>
      this.options.native.recordError("recorder_write_failed", error),
    );
    return operation;
  }

  async flush() {
    await this.#queue;
    return this.options.native.flush();
  }

  close(): Promise<void> {
    if (this.#aborting) return Promise.reject(new Error("SCRY_BROWSER_RECORDER_CLOSED"));
    return (this.#closing ??= this.finishClose());
  }
  private async finishClose(): Promise<void> {
    this.assertOpen();
    await this.checkpoint("final");
    this.stopAcceptingPages();
    await Promise.all([...this.#attachments]);
    await this.#queue;
    for (const [page, entry] of this.#pages) {
      if (!page.isClosed()) await page.screencast.stop();
      await this.options.native.admit({
        filename: entry.filename,
        kind: "video",
        timestamp: entry.started,
        durationMs: Math.max(0, Date.now() - entry.started),
        label: "page",
      });
    }
    await this.options.native.flush();
    await Promise.allSettled([...this.#privateWorlds.values()].map((session) => session.detach()));
  }

  abort(): Promise<void> {
    if (!this.#aborting) {
      this.stopAcceptingPages();
      this.#aborting = Promise.all([
        this.options.native.abort(),
        this.#queue,
        this.#closing?.catch(() => undefined),
        ...this.#attachments,
        ...[...this.#privateWorlds.values()].map((session) =>
          session.detach().catch(() => undefined),
        ),
        ...[...this.#pages.keys()]
          .filter((page) => !page.isClosed())
          .map((page) => page.screencast.stop().catch(() => undefined)),
      ]).then(() => undefined);
    }
    return this.#aborting;
  }
  private assertOpen() {
    if (this.#closed) throw new Error("SCRY_BROWSER_RECORDER_CLOSED");
  }
  private stopAcceptingPages() {
    this.#closed = true;
    for (const context of this.#contexts) context.off("page", this.#onPage);
  }
  private async privateEvaluation(page: Page, expression: string): Promise<void> {
    const session = this.#privateWorlds.get(page);
    if (!session) return;
    const tree = await session.send("Page.getFrameTree");
    const world = await session.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "scry-native-protection",
      grantUniveralAccess: false,
    });
    const result = await session.send("Runtime.evaluate", {
      expression: `if (typeof globalThis.__scryNativeRefresh !== 'function') throw new Error('native_mask_not_installed'); ${expression}`,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: false,
    });
    if (result.exceptionDetails) throw new Error("native_mask_refresh_failed");
  }
}
