import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserContext, Page, CDPSession } from "playwright";
import type {
  ChronicleNativeRecordingPort,
  NativeBrowserProtectionPort,
  NativeCapturePort,
  NativeCaptureSample,
  NativeCaptureRecovery,
  NativeImageReason,
} from "@scry/contracts";
// @ts-expect-error Private JavaScript transport, shared with the native adapter.
import { createCaptureProducer } from "./mcp-native/capture-producer.mjs";
// @ts-expect-error Private isolated-world binding transport.
import { installCaptureBinding } from "./mcp-native/capture-binding.mjs";
// @ts-expect-error Private bounded browser maintenance transport.
import { refreshNativeProtection } from "./mcp-native/protection-refresh.mjs";
// @ts-expect-error Private task lanes with the existing 200 ms maintenance budget.
import { BestEffortTasks } from "./mcp-native/best-effort-tasks.mjs";

type ProducerEvent =
  | { type: "capture_sample"; sequence: number; sample: NativeCaptureSample }
  | { type: "capture_gap"; sequence: number; reason: NativeImageReason };
type Entry = {
  capture: NativeCapturePort;
  protection: NativeBrowserProtectionPort;
  producer: ReturnType<typeof createCaptureProducer>;
  started: number;
  capturing: boolean;
  session?: CDPSession;
  scriptRevision: number;
  policyGeneration: number;
};
/** Native pixels are prospective candidates. Chronicle alone admits sealed media. */
export class SanitizedBrowserRecorder {
  readonly #pages = new Map<Page, Entry>();
  readonly #contexts = new Set<BrowserContext>();
  readonly #attachments = new Set<Promise<void>>();
  readonly #dialogs = new Map<unknown, Page>();
  readonly #maskTasks = new BestEffortTasks(() => this.options.native.maskingUnavailable(), 200);
  readonly #pixelTasks = new BestEffortTasks(() => this.options.native.maskingUnavailable(), 200);
  #closed = false;
  #acceptingPages = true;
  #queue: Promise<void> = Promise.resolve();
  #aborting?: Promise<void>;
  #closing?: Promise<void>;
  readonly #onPage = (page: Page) => {
    if (this.#acceptingPages)
      void this.attach(page).catch((error) =>
        this.options.native.recordError("recorder_attach_failed", error),
      );
  };
  constructor(
    private readonly options: {
      native: ChronicleNativeRecordingPort;
      protection: NativeBrowserProtectionPort;
      recoverCaptures: () => Promise<NativeCaptureRecovery>;
    },
  ) {}
  async start(context: BrowserContext) {
    await Promise.resolve();
    this.assertOpen();
    if (this.#contexts.has(context)) return;
    this.#contexts.add(context);
    context.on("page", this.#onPage);
    for (const page of context.pages()) await this.attach(page);
  }
  private attach(page: Page) {
    const work = this.attachPage(page);
    this.#attachments.add(work);
    void work.finally(() => this.#attachments.delete(work)).catch(() => {});
    return work;
  }
  private async attachPage(page: Page) {
    this.assertOpen();
    if (this.#pages.has(page)) return;
    const capture = await this.options.native.reserveCaptureV2({
      kind: "screencast",
      policyGeneration: this.options.protection.policyGeneration,
    });
    this.assertOpen();
    const protection = this.options.protection.fork(capture.epoch);
    const entry: Entry = {
      capture,
      protection,
      producer: undefined,
      started: Date.now(),
      capturing: false,
      scriptRevision: 0,
      policyGeneration: protection.policyGeneration,
    };
    entry.producer = createCaptureProducer({
      epoch: capture.epoch,
      sample: () => protection.captureSample(),
      send: (event: ProducerEvent) =>
        event.type === "capture_gap"
          ? capture.graphGap({ sequence: event.sequence, reason: event.reason })
          : capture.graphSample({ sequence: event.sequence, sample: event.sample }),
    });
    this.#pages.set(page, entry);
    page.on("dialog", (dialog) => this.#dialogs.set(dialog, page));
    try {
      const session = await page.context().newCDPSession(page);
      entry.session = session;
      await session.send("Page.enable");
      await installCaptureBinding(session, protection, (reason: NativeImageReason) =>
        entry.producer.gap(reason),
      );
      const source = protection.script,
        revision = protection.scriptRevision;
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source,
        worldName: "scry-native-protection",
        runImmediately: true,
      });
      entry.scriptRevision = revision;
      await this.refresh(page, entry);
    } catch (error) {
      this.options.native.maskingUnavailable();
      this.options.native.recordError("recorder_attach_failed", error);
    }
    this.assertOpen();
    entry.started = Date.now();
    await page.screencast.start({
      path: path.join(capture.directory, capture.filename),
      size: page.viewportSize() ?? { width: 1280, height: 720 },
    });
    entry.capturing = true;
    if (this.#closed && !page.isClosed()) await page.screencast.stop();
  }
  private async syncDocuments(page: Page, entry: Entry) {
    if (!entry.session || page.isClosed()) return;
    for (const update of entry.protection.documentUpdatesSince(entry.scriptRevision)) {
      await entry.session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: update.script,
        worldName: "scry-native-protection",
        runImmediately: true,
      });
      entry.scriptRevision = update.revision;
    }
  }
  private async refresh(
    page: Page,
    entry: Entry,
    options: { challenge?: string; record?: boolean } = {},
  ) {
    if (!entry.session || page.isClosed()) throw Error("native_graph_unavailable");
    await this.syncDocuments(page, entry);
    const read = await refreshNativeProtection({
      protection: entry.protection,
      sessions: new Map([[page, entry.session]]),
      pages: [page],
      pageId: () => 0,
      selectedPage: page,
      finalReadChallenge: options.challenge,
      dialogs: this.#dialogs,
      maskTasks: this.#maskTasks,
      pixelTasks: this.#pixelTasks,
      recovered: () => {},
      degrade: () => this.options.native.maskingUnavailable(),
      phase: () => {},
    });
    await this.syncDocuments(page, entry);
    for (const reason of entry.protection.drainGaps()) entry.producer.gap(reason);
    if (options.record !== false && entry.protection.captureSample().readId === read)
      entry.producer.sample();
  }
  async protectValue(value: string) {
    for (const entry of this.#pages.values()) entry.producer.pauseSamples();
    this.options.protection.updateSecrets({ selected: value });
    for (const [page, entry] of this.#pages) {
      try {
        await this.syncDocuments(page, entry);
        const next = entry.protection.policyGeneration;
        if (next !== entry.policyGeneration) {
          await entry.capture.policyTransition({
            from: entry.policyGeneration,
            to: next,
            acknowledged: true,
          });
          entry.policyGeneration = next;
        }
        entry.producer.resumeSamples();
      } catch {
        this.options.native.maskingUnavailable();
        await entry.capture
          .policyTransition({
            from: entry.policyGeneration,
            to: entry.protection.policyGeneration,
            acknowledged: false,
          })
          .catch(() => {});
      }
    }
  }
  checkpoint(label = "commit"): Promise<void> {
    this.assertOpen();
    const operation = this.#queue.then(async () => {
      if (this.#closed) return;
      for (const [page, entry] of this.#pages)
        if (!page.isClosed()) await this.still(page, entry, label);
    });
    this.#queue = operation.catch((error) =>
      this.options.native.recordError("recorder_write_failed", error),
    );
    return operation;
  }
  private async still(page: Page, entry: Entry, label: string) {
    const token = entry.protection.beginImageCapture(0),
      filename = randomUUID() + ".png";
    try {
      await this.refresh(page, entry);
      if (entry.protection.imageEvidence().state !== "available") return;
      await page.screenshot({
        path: path.join(this.options.native.directory, filename),
        timeout: 5000,
      });
      await this.refresh(page, entry);
      const imageEvidence = entry.protection.imageEvidence();
      if (this.#closed || imageEvidence.state !== "available") return;
      await this.options.native.admitStill({
        filename,
        timestamp: Date.now(),
        label,
        imageEvidence,
      });
    } catch {
      this.options.native.maskingUnavailable();
    } finally {
      entry.protection.endImageCapture(token);
    }
  }
  async flush() {
    await this.#queue;
    return this.options.native.flush();
  }
  close(): Promise<void> {
    if (this.#aborting) return Promise.reject(Error("SCRY_BROWSER_RECORDER_CLOSED"));
    return (this.#closing ??= this.finishClose());
  }
  private async finishClose() {
    this.assertOpen();
    this.stopAcceptingPages();
    await Promise.allSettled([...this.#attachments]);
    await this.#queue;
    try {
      for (const [page, entry] of this.#pages) {
        try {
          if (!entry.capturing || page.isClosed())
            throw Error("native_capture_final_assessment_missing");
          await page.screencast.stop();
          entry.capturing = false;
          const final = await entry.capture.physicalStopped({
            epoch: entry.capture.epoch,
            started: entry.started,
            ended: Date.now(),
            physicalCoverage: "complete",
          });
          const reply = await entry.producer.close(
            { epoch: entry.capture.epoch, challenge: final.challenge },
            async (challenge: string) => this.refresh(page, entry, { challenge, record: false }),
          );
          await entry.capture.graphSample({
            sequence: reply.lastSequence,
            sample: reply.finalSample,
          });
          await entry.capture.graphClosed({ lastSequence: reply.lastSequence });
        } catch {
          this.options.native.maskingUnavailable();
          entry.producer.abandon();
        } finally {
          await entry.capture.seal();
        }
        if (!page.isClosed()) await this.still(page, entry, "final");
      }
      await this.options.recoverCaptures();
      await this.options.native.flush();
    } finally {
      this.#closed = true;
      await Promise.allSettled(
        [...this.#pages.values()].map(async (entry) => {
          entry.producer.abandon();
          entry.protection.dispose();
          await entry.session?.detach().catch(() => {});
        }),
      );
      this.options.protection.dispose();
    }
  }
  abort(): Promise<void> {
    return (this.#aborting ??= (async () => {
      this.stopAcceptingPages();
      this.#closed = true;
      for (const entry of this.#pages.values()) entry.producer.abandon();
      const nativeAbort = this.options.native.abort();
      await Promise.allSettled([
        nativeAbort,
        this.#queue,
        this.#closing,
        ...this.#attachments,
        ...[...this.#pages].map(async ([page, entry]) => {
          if (entry.capturing && !page.isClosed()) await page.screencast.stop().catch(() => {});
          entry.protection.dispose();
          await entry.session?.detach().catch(() => {});
        }),
      ]);
      this.options.protection.dispose();
      await nativeAbort;
    })());
  }
  private assertOpen() {
    if (this.#closed) throw Error("SCRY_BROWSER_RECORDER_CLOSED");
  }
  private stopAcceptingPages() {
    this.#acceptingPages = false;
    for (const context of this.#contexts) context.off("page", this.#onPage);
  }
}
