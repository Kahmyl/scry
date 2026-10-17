import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, CDPSession, Frame, Page } from "playwright";
import {
  sanitizeReplayValue,
  SensitiveValueClassifier,
  ProtectionAuthority,
  recordingProtectionOptions,
} from "@scry/veil";

export interface ReplayEventStore {
  readonly nextSequence: number;
  append(event: unknown): Promise<number>;
  flush(): Promise<unknown>;
}

function isOwnerClosure(error: unknown): boolean {
  return /Target page, context or browser has been closed|Session closed|Page crashed|Browser closed|Connection closed/iu.test(
    error instanceof Error ? error.message : "",
  );
}

export class SanitizedBrowserRecorder {
  readonly #store: ReplayEventStore;
  readonly #classifier: SensitiveValueClassifier;
  readonly #authority: ProtectionAuthority | undefined;
  readonly #sessions = new Map<Page, CDPSession>();
  readonly #contexts = new Set<BrowserContext>();
  readonly #errors: Array<{ code: string; message?: string }> = [];
  readonly #diagnostics: Array<{ code: string }> = [];
  #source: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #receivedEvents: number;

  constructor(options: {
    store: ReplayEventStore;
    classifier?: SensitiveValueClassifier;
    authority?: ProtectionAuthority;
    protectedValues?: Readonly<Record<string, string>>;
  }) {
    this.#store = options.store;
    this.#classifier = options.classifier ?? new SensitiveValueClassifier();
    this.#authority = options.authority;
    this.#receivedEvents = options.store.nextSequence;
  }

  async start(context: BrowserContext): Promise<void> {
    await this.#loadSource();
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

  async flush(): Promise<{
    receivedEvents: number;
    errors: Array<{ code: string; message?: string }>;
    diagnostics: Array<{ code: string }>;
  }> {
    await this.#queue;
    await this.#store.flush();
    return {
      receivedEvents: this.#receivedEvents,
      errors: structuredClone(this.#errors),
      diagnostics: structuredClone(this.#diagnostics),
    };
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
    await this.flush();
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
          ...${JSON.stringify(recordingProtectionOptions)},
          checkoutEveryNms: 5000
        });
      };
      globalThis.__scryRestartRecorder = start;
      if (!globalThis.__scryRecorderStarted) start();
    })();`;
  }

  async #attach(context: BrowserContext, page: Page): Promise<void> {
    if (this.#sessions.has(page)) return;
    const session = await context.newCDPSession(page);
    this.#sessions.set(page, session);
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", {
      name: "__scry_emit",
      executionContextName: "scry-recorder",
    });
    session.on("Runtime.bindingCalled", (event) => {
      if (event.name !== "__scry_emit") return;
      const forceQuarantine = this.#authority?.hasActiveBarrier ?? false;
      this.#queue = this.#queue
        .then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.payload) as unknown;
          } catch {
            this.#errors.push({ code: "recorder_payload_invalid" });
            return;
          }
          const structurallySanitized = sanitizeReplayValue(parsed, {
            sanitize: (input) =>
              this.#authority
                ? this.#authority.sanitize(input, "recording", forceQuarantine)
                : this.#classifier.sanitize(input),
          });
          await this.#store.append(structurallySanitized);
          this.#receivedEvents += 1;
        })
        .catch((error: unknown) => this.#recordError("recorder_write_failed", error));
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

  #recordError(code: string, error: unknown): void {
    if (isOwnerClosure(error)) {
      this.#diagnostics.push({ code: "owner_closed_during_capture" });
      return;
    }
    this.#errors.push({ code, ...(error instanceof Error ? { message: error.message } : {}) });
  }

  #requiredSource(): string {
    if (!this.#source) throw new Error("recorder_source_not_loaded");
    return this.#source;
  }
}
