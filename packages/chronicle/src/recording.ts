import {
  recordingFailureCodes,
  type RecordingFailureCode,
  type ChronicleRecordingPort,
  type RecordingProtectionPort,
} from "@scry/contracts";

export interface ReplayEventStore {
  readonly nextSequence: number;
  append(event: unknown): Promise<number>;
  flush(): Promise<unknown>;
  discardPending(): void;
}

/** Admits protected events in receipt order before they become durable evidence. */
export class ChronicleRecording implements ChronicleRecordingPort {
  #queue: Promise<void> = Promise.resolve();
  #abandonment: Promise<void> | undefined;
  #receivedEvents: number;
  readonly #errors: Array<{ code: RecordingFailureCode }> = [];
  readonly #diagnostics: Array<{ code: "owner_closed_during_capture" }> = [];

  constructor(
    private readonly store: ReplayEventStore,
    private readonly protection: RecordingProtectionPort,
  ) {
    this.#receivedEvents = store.nextSequence;
  }

  receive(payload: string): void {
    if (this.#abandonment) return;
    const protect = this.protection.snapshot();
    this.#queue = this.#queue
      .then(async () => {
        if (this.#abandonment) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          this.#errors.push({ code: "recorder_payload_invalid" });
          return;
        }
        await this.store.append(protect(parsed));
        this.#receivedEvents += 1;
      })
      .catch((error: unknown) => this.recordError("recorder_write_failed", error));
  }

  recordError(code: RecordingFailureCode, error: unknown): void {
    if (
      /Target page, context or browser has been closed|Session closed|Page crashed|Browser closed|Connection closed/iu.test(
        error instanceof Error ? error.message : "",
      )
    ) {
      this.#diagnostics.push({ code: "owner_closed_during_capture" });
      return;
    }
    this.#errors.push({
      code: recordingFailureCodes.find((value) => value === code) ?? "recorder_capture_failed",
    });
  }

  assertActive(): void {
    if (this.#abandonment) throw new Error("SCRY_BROWSER_RECORDER_CLOSED");
  }

  flush() {
    if (this.#abandonment) return Promise.reject(new Error("SCRY_BROWSER_RECORDER_CLOSED"));
    const flushed = this.#queue.then(async () => {
      this.assertActive();
      await this.store.flush();
      this.assertActive();
      return {
        receivedEvents: this.#receivedEvents,
        errors: structuredClone(this.#errors),
        diagnostics: structuredClone(this.#diagnostics),
      };
    });
    // Explicit flushes and appends share one ordering point. A failed caller
    // still observes its rejection; the queue retains finite failure diagnostics
    // and can be joined without mistaking rejection for unfinished I/O.
    this.#queue = flushed.then(
      () => undefined,
      (error) => this.recordError("recorder_write_failed", error),
    );
    return flushed;
  }

  abort(): Promise<void> {
    if (!this.#abandonment) {
      // Set permanent abandonment before any queued callback can run. Already
      // active work settles first; queued work sees this latch and never starts
      // a new append or flush. Failed discard retains this exact failed receipt.
      this.#abandonment = this.#queue.then(() => this.store.discardPending());
    }
    return this.#abandonment;
  }
}
