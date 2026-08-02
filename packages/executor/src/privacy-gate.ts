import type {
  CaptureDecision,
  EvidenceChannel,
  PrivacyFailure,
  PrivacyState,
  PrivacyMode,
  SafeResumeBoundary,
} from "@scry/contracts";

export type PrivacyCollector = {
  name: string;
  arm(operationId: string, preparation?: PrivacyPreparation): Promise<void>;
  resume(boundary: SafeResumeBoundary): Promise<void>;
  seal(reason: PrivacyFailure): Promise<void>;
  finalize(): Promise<void>;
};

export type PrivacyPreparation = { mode: PrivacyMode; videoMaskEstablished: boolean };

type PrivacyEvent = {
  state: PrivacyState;
  operationId?: string;
  collector?: string;
  code?: string;
  acknowledgements?: string[];
};

export class PrivacyTransitionError extends Error {
  override name = "PrivacyTransitionError";
}

export class PrivacyGate {
  private currentState: PrivacyState = "normal";
  private operationId: string | undefined;
  private preparation: PrivacyPreparation | undefined;
  private transition = Promise.resolve();
  private finalized = false;

  constructor(
    private readonly collectors: PrivacyCollector[],
    private readonly emit: (event: PrivacyEvent) => Promise<void> = async () => undefined,
    private readonly acknowledgementTimeoutMs = 5_000,
  ) {
    const names = collectors.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new Error("Privacy collector names must be unique");
  }

  state() { return this.currentState; }
  isSuppressed() { return !["normal"].includes(this.currentState); }

  getDecision(channel: EvidenceChannel): CaptureDecision {
    if (this.currentState === "sealed" || ["aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(this.currentState)) return "quarantine";
    if (this.currentState !== "normal") {
      if (channel === "video" && this.preparation?.videoMaskEstablished && this.preparation.mode !== "protected_recording_gap") return "allow";
      return channel === "event" || channel === "report" || channel === "metadata" ? "sanitize" : "suppress";
    }
    if (["dom", "accessibility", "console", "page_error", "network", "event", "report", "metadata"].includes(channel)) return "sanitize";
    if (channel === "clipboard" || channel === "download") return "suppress";
    return "allow";
  }

  prepare(operationId: string, preparation: PrivacyPreparation = { mode: "protected_recording_gap", videoMaskEstablished: false }) {
    return this.serial(async () => {
      this.expect("normal");
      if (this.finalized) throw new PrivacyTransitionError("Privacy gate is finalized");
      this.operationId = operationId;
      this.preparation = preparation;
      await this.setState("arming");
      const acknowledged: string[] = [];
      try {
        await Promise.all(this.collectors.map(async (collector) => {
          try {
            await bounded(collector.arm(operationId, preparation), this.acknowledgementTimeoutMs, `COLLECTOR_ARM_TIMEOUT:${collector.name}`);
            acknowledged.push(collector.name);
          } catch (error) {
            throw new Error(`COLLECTOR_ARM_FAILED:${collector.name}`, { cause: error });
          }
        }));
      } catch (error) {
        await this.sealInternal({ code: "COLLECTOR_ARM_FAILED", collector: collectorFrom(error) });
        throw new PrivacyTransitionError(error instanceof Error ? error.message : String(error));
      }
      await this.setState("armed", { acknowledgements: acknowledged });
      await this.setState("ready_to_reveal");
    });
  }

  beginProtected() { return this.serial(async () => { this.expect("ready_to_reveal"); await this.setState("protected"); }); }
  markCaptured() { return this.serial(async () => { this.expect("protected"); await this.setState("captured"); }); }
  beginSafeBoundary() { return this.serial(async () => { this.expect("captured"); await this.setState("establishing_safe_boundary"); }); }

  confirmSafeBoundary(boundary: SafeResumeBoundary) {
    return this.serial(async () => {
      this.expect("establishing_safe_boundary");
      await this.setState("safe_to_resume");
      try {
        await Promise.all(this.collectors.map(async (collector) => {
          try { await bounded(collector.resume(boundary), this.acknowledgementTimeoutMs, `COLLECTOR_RESUME_TIMEOUT:${collector.name}`); }
          catch (error) { throw new Error(`COLLECTOR_RESUME_FAILED:${collector.name}`, { cause: error }); }
        }));
      } catch (error) {
        await this.sealInternal({ code: "COLLECTOR_RESUME_FAILED", collector: collectorFrom(error) });
        throw new PrivacyTransitionError(error instanceof Error ? error.message : String(error));
      }
      await this.setState("normal");
      this.operationId = undefined;
      this.preparation = undefined;
    });
  }

  seal(reason: PrivacyFailure) { return this.serial(() => this.sealInternal(reason)); }

  terminate(disposition: "aborted" | "continuing_unrecorded" | "restarting_checkpoint") {
    return this.serial(async () => { this.expect("sealed"); await this.setState(disposition); });
  }

  finalize() {
    return this.serial(async () => {
      if (this.finalized) return;
      if (this.currentState !== "normal" && !["sealed", "aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(this.currentState)) {
        await this.sealInternal({ code: "FINALIZED_DURING_PRIVACY_TRANSITION" });
      }
      await Promise.allSettled(this.collectors.map((collector) => collector.finalize()));
      this.finalized = true;
    });
  }

  private async sealInternal(reason: PrivacyFailure) {
    if (["sealed", "aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(this.currentState)) return;
    this.currentState = "sealed";
    await this.emit({
      state: "sealed",
      ...(this.operationId ? { operationId: this.operationId } : {}),
      code: reason.code,
      ...(reason.collector ? { collector: reason.collector } : {}),
    });
    await Promise.allSettled(this.collectors.map((collector) => collector.seal(reason)));
  }

  private async setState(state: PrivacyState, extra: Partial<PrivacyEvent> = {}) {
    this.currentState = state;
    await this.emit({ state, ...(this.operationId ? { operationId: this.operationId } : {}), ...extra });
  }

  private expect(expected: PrivacyState) {
    if (this.currentState !== expected) throw new PrivacyTransitionError(`Expected privacy state ${expected}, received ${this.currentState}`);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function collectorFrom(error: unknown) {
  const match = (error instanceof Error ? error.message : String(error)).match(/:([^:]+)$/);
  return match?.[1];
}
