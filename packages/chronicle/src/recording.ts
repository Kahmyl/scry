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
}

/** Admits protected events in receipt order before they become durable evidence. */
export class ChronicleRecording implements ChronicleRecordingPort {
  #queue: Promise<void> = Promise.resolve();
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
    const protect = this.protection.snapshot();
    this.#queue = this.#queue
      .then(async () => {
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

  async flush() {
    await this.#queue;
    await this.store.flush();
    return {
      receivedEvents: this.#receivedEvents,
      errors: structuredClone(this.#errors),
      diagnostics: structuredClone(this.#diagnostics),
    };
  }
}
