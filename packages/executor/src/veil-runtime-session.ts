import {
  VEIL_CONTRACT_VERSION,
  veilCollectorAcknowledgementSchema,
  type VeilCollectorAcknowledgement,
  type VeilCollectorPhase,
  type VeilFailure,
  type VeilRuntimeState,
  type VeilRuntimeTransition,
} from "@scry/contracts";

export type VeilRuntimeCollector = {
  id: string;
  transition(phase: VeilCollectorPhase, context: { operationId?: string; stateVersion: number; signal: AbortSignal }): Promise<VeilCollectorAcknowledgement>;
};

export type VeilRuntimeCheckpoint = Readonly<{ policyDigest: string; contextIdentity: string; sequence: number }>;

export class VeilRuntimeError extends Error {
  override name = "VeilRuntimeError";
  constructor(readonly code: string, message: string) { super(message); }
}

export class VeilRuntimeSession {
  private current: VeilRuntimeState = "normal";
  // The initial normal state is version 1. Collector acknowledgements require a
  // positive state version even when a run never enters a protected interval.
  private sequence = 1;
  private operationId: string | undefined;
  private queue = Promise.resolve();
  private finalized = false;
  private finalizeFailures: string[] = [];
  private controller = new AbortController();

  constructor(
    private readonly collectors: readonly VeilRuntimeCollector[],
    readonly policyDigest: string,
    readonly contextIdentity: string,
    private readonly emit: (event: VeilRuntimeTransition) => Promise<void> = async () => undefined,
    private readonly acknowledgementTimeoutMs = 5_000,
  ) {
    const ids = collectors.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new VeilRuntimeError("VEIL_DUPLICATE_COLLECTOR", "Collector identifiers must be unique");
  }

  state(): VeilRuntimeState { return this.current; }

  prepare(operationId: string): Promise<void> {
    return this.serial(async () => {
      this.expect("normal"); this.assertActive(); this.operationId = operationId;
      await this.move("preparing"); await this.collect("prepare");
      await this.move("suspended"); await this.collect("suspend");
      await this.move("isolated"); await this.collect("isolate");
    });
  }

  beginProtected(): Promise<void> { return this.serial(async () => { this.expect("isolated"); await this.move("protected"); }); }

  resume(): Promise<void> {
    return this.serial(async () => {
      this.expect("protected"); await this.move("resuming"); await this.collect("resume");
      await this.move("normal"); this.operationId = undefined;
    });
  }

  seal(reason: VeilFailure): Promise<void> { return this.serial(() => this.sealInternal(reason.code)); }

  cancel(): Promise<void> {
    this.controller.abort();
    return this.serial(() => this.sealInternal("VEIL_RUNTIME_CANCELLED"));
  }

  checkpoint(): VeilRuntimeCheckpoint {
    if (this.current !== "normal") throw new VeilRuntimeError("VEIL_CHECKPOINT_UNSAFE", "Checkpoints are only valid at a normal boundary");
    return Object.freeze({ policyDigest: this.policyDigest, contextIdentity: this.contextIdentity, sequence: this.sequence });
  }

  restore(checkpoint: VeilRuntimeCheckpoint): Promise<void> {
    return this.serial(async () => {
      if (this.current !== "sealed") throw new VeilRuntimeError("VEIL_RESTORE_STATE_INVALID", "Only a sealed session can restore a checkpoint");
      if (checkpoint.policyDigest !== this.policyDigest || checkpoint.contextIdentity !== this.contextIdentity) throw new VeilRuntimeError("VEIL_CHECKPOINT_STALE", "Checkpoint policy or context is stale");
      this.controller = new AbortController(); this.operationId = undefined; await this.move("normal", "VEIL_CHECKPOINT_RESTORED");
    });
  }

  finalize(): Promise<void> {
    return this.serial(async () => {
      if (this.finalized) return;
      if (this.current !== "normal" && this.current !== "sealed") await this.sealInternal("VEIL_FINALIZED_DURING_TRANSITION");
      const finalized = await this.collect("finalize", true);
      if (!finalized) throw new VeilRuntimeError("VEIL_COLLECTOR_FINALIZE_FAILED", `Collectors did not finalize: ${this.finalizeFailures.join(",") || "unknown"}`);
      await this.move("finalized"); this.finalized = true;
    });
  }

  private async collect(phase: VeilCollectorPhase, tolerateFailure = false): Promise<boolean> {
    const stateVersion = this.sequence;
    try {
      const results = await Promise.allSettled(this.collectors.map(async (collector) => {
        const acknowledgement = await bounded(collector.transition(phase, { ...(this.operationId ? { operationId: this.operationId } : {}), stateVersion, signal: this.controller.signal }), this.acknowledgementTimeoutMs);
        const parsed = veilCollectorAcknowledgementSchema.parse(acknowledgement);
        if (parsed.collectorId !== collector.id || parsed.phase !== phase || parsed.stateVersion !== stateVersion || parsed.operationId !== this.operationId) {
          throw new VeilRuntimeError("VEIL_FALSE_ACKNOWLEDGEMENT", `Collector ${collector.id} returned a mismatched acknowledgement`);
        }
      }));
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${this.collectors[index]?.id ?? `collector-${index}`}:${result.reason instanceof VeilRuntimeError ? result.reason.code : "TRANSITION_FAILED"}`] : []);
      if (failures.length) {
        if (phase === "finalize") this.finalizeFailures = failures;
        throw new VeilRuntimeError("VEIL_COLLECTOR_TRANSITION_FAILED", `Collectors failed ${phase}: ${failures.join(",")}`);
      }
      return true;
    } catch (error) {
      if (tolerateFailure) return false;
      await this.sealInternal(error instanceof VeilRuntimeError ? error.code : "VEIL_COLLECTOR_TRANSITION_FAILED");
      throw error instanceof VeilRuntimeError ? error : new VeilRuntimeError("VEIL_COLLECTOR_TRANSITION_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async sealInternal(reasonCode: string): Promise<void> {
    if (this.current === "sealed" || this.current === "finalized") return;
    this.controller.abort(); await this.move("sealed", reasonCode);
    const sealed = await this.collect("seal", true);
    if (!sealed) throw new VeilRuntimeError("VEIL_COLLECTOR_SEAL_FAILED", "One or more collectors did not acknowledge sealing");
  }

  private async move(to: VeilRuntimeState, reasonCode?: string): Promise<void> {
    const from = this.current; this.current = to; this.sequence += 1;
    await this.emit({ schemaVersion: VEIL_CONTRACT_VERSION, sequence: this.sequence, from, to, ...(this.operationId ? { operationId: this.operationId } : {}), ...(reasonCode ? { reasonCode } : {}), occurredAt: new Date().toISOString() });
  }

  private expect(expected: VeilRuntimeState): void { if (this.current !== expected) throw new VeilRuntimeError("VEIL_TRANSITION_INVALID", `Expected ${expected}, received ${this.current}`); }
  private assertActive(): void { if (this.finalized) throw new VeilRuntimeError("VEIL_RUNTIME_FINALIZED", "Runtime session is finalized"); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation, operation); this.queue = next.then(() => undefined, () => undefined); return next; }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new VeilRuntimeError("VEIL_COLLECTOR_TIMEOUT", "Collector acknowledgement timed out")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
