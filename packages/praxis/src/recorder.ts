import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, CDPSession, Frame, Page } from "playwright";
import type { ChronicleRecordingPort, RecordingFailureCode } from "@scry/contracts";

export class SanitizedBrowserRecorder {
  readonly #sessions = new Map<Page, CDPSession>();
  readonly #contexts = new Set<BrowserContext>();
  #source: string | null = null;
  #closed = false;

  constructor(
    private readonly options: {
      recording: ChronicleRecordingPort;
      privacyOptions: Readonly<Record<string, unknown>>;
    },
  ) {}

  async start(context: BrowserContext): Promise<void> {
    if (this.#closed) throw new Error("SCRY_BROWSER_RECORDER_CLOSED");
    await this.#loadSource();
    if (this.#closed) throw new Error("SCRY_BROWSER_RECORDER_CLOSED");
    if (this.#contexts.has(context)) return;
    this.#contexts.add(context);
    context.on("page", (page) => {
      void this.#attach(context, page).catch((error: unknown) =>
        this.#recordError("recorder_attach_failed", error),
      );
    });
    context.once("close", () => this.#contexts.delete(context));
    for (const page of context.pages()) await this.#attach(context, page);
  }

  flush() {
    return this.options.recording.flush();
  }

  /** Emit a complete rrweb snapshot after Veil closes a quarantine barrier. */
  async checkpoint(): Promise<void> {
    for (const [page, session] of this.#sessions) {
      if (page.isClosed()) continue;
      const tree = await session.send("Page.getFrameTree");
      const world = await session.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "scry-recorder",
        grantUniveralAccess: false,
      });
      const installed = await session.send("Runtime.evaluate", {
        expression:
          "globalThis.__scryRecorderStarted === true && typeof globalThis.rrweb?.record?.takeFullSnapshot === 'function'",
        contextId: world.executionContextId,
        returnByValue: true,
      });
      if (installed.result.value !== true)
        await session.send("Runtime.evaluate", {
          expression: this.#requiredSource(),
          contextId: world.executionContextId,
          awaitPromise: true,
          returnByValue: false,
        });
      const result = await session.send("Runtime.evaluate", {
        expression:
          "(() => { if (typeof globalThis.rrweb?.record?.takeFullSnapshot !== 'function') return false; try { globalThis.rrweb.record.takeFullSnapshot(); } catch { globalThis.__scryRestartRecorder?.(); globalThis.rrweb.record.takeFullSnapshot(); } return true; })()",
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails || result.result.value !== true)
        throw new Error(
          `recorder_checkpoint_failed:${result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? String(result.result.value)}`,
        );
    }
    await this.flush();
  }

  async close(): Promise<void> {
    await this.#detach();
    await this.flush();
  }

  /** Detach without publishing buffered evidence after ownership loss. */
  async abort(): Promise<void> {
    this.#closed = true;
    await Promise.all([this.options.recording.abort(), this.#detach()]);
  }

  async #detach(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#sessions.values()].map((session) => session.detach()));
    this.#sessions.clear();
  }

  async #loadSource(): Promise<void> {
    if (this.#source) return;
    const require = createRequire(import.meta.url);
    const rrwebPath = path.resolve(path.dirname(require.resolve("rrweb")), "../umd/rrweb.min.js");
    const rrwebSource = await readFile(rrwebPath, "utf8");
    this.#source = `${rrwebSource}\n;(() => {
      let sourceSequence = 0;
      const emit = event => {
        try {
          event.__scry_source_sequence = sourceSequence++;
          event.__scry_frame = location.origin + location.pathname;
          globalThis.__scry_emit(JSON.stringify(event));
        } catch {
          globalThis.__scry_emit(JSON.stringify({
            __scry_source_sequence: sourceSequence++,
            __scry_error: 'capture_sanitization_failed',
            message: '[REDACTED]'
          }));
        }
      };
      const start = () => {
        try { globalThis.__scryRecorderStop?.(); } catch {}
        globalThis.__scryRecorderStarted = true;
        globalThis.__scryRecorderStop = globalThis.rrweb.record({
          emit,
          ...${JSON.stringify(this.options.privacyOptions)},
          checkoutEveryNms: 5000
        });
      };
      globalThis.__scryRestartRecorder = start;
      if (!globalThis.__scryRecorderStarted) start();
    })();`;
  }

  async #attach(context: BrowserContext, page: Page): Promise<void> {
    if (this.#closed || this.#sessions.has(page)) return;
    const session = await context.newCDPSession(page);
    if (this.#closed) {
      await session.detach().catch(() => undefined);
      return;
    }
    this.#sessions.set(page, session);
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", {
      name: "__scry_emit",
      executionContextName: "scry-recorder",
    });
    session.on("Runtime.bindingCalled", (event) => {
      if (this.#closed || event.name !== "__scry_emit") return;
      this.options.recording.receive(event.payload);
    });
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: this.#requiredSource(),
      worldName: "scry-recorder",
      runImmediately: true,
    });
    const install = async (frame: Frame): Promise<void> => {
      if (frame !== page.mainFrame()) return;
      try {
        const tree = await session.send("Page.getFrameTree");
        const world = await session.send("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: "scry-recorder",
          grantUniveralAccess: false,
        });
        await session.send("Runtime.evaluate", {
          expression: this.#requiredSource(),
          contextId: world.executionContextId,
          awaitPromise: true,
          returnByValue: false,
        });
      } catch (error) {
        this.#recordError("recorder_navigation_reinstall_failed", error);
      }
    };
    page.on("framenavigated", (frame) => {
      void install(frame);
    });
    await install(page.mainFrame());
    page.once("close", () => this.#sessions.delete(page));
  }

  #recordError(code: RecordingFailureCode, error: unknown): void {
    this.options.recording.recordError(code, error);
  }

  #requiredSource(): string {
    if (!this.#source) throw new Error("recorder_source_not_loaded");
    return this.#source;
  }
}
