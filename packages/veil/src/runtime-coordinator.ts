import type {
  CaptureDecision,
  EvidenceChannel,
  PrivacyFailure,
  PrivacyState,
  PrivacyMode,
  SafeResumeBoundary,
} from "@scry/contracts";
import {
  VEIL_CONTRACT_VERSION,
  type VeilCollectorAcknowledgement,
  type VeilCollectorPhase,
  type VeilFailure,
} from "@scry/contracts";
import { VeilRuntimeSession, type VeilRuntimeCollector } from "./runtime-session.js";

export type PrivacyCollector = {
  name: string;
  arm(operationId: string, preparation?: PrivacyPreparation): Promise<void>;
  suspend(): Promise<void>;
  isolate(): Promise<void>;
  resume(boundary: SafeResumeBoundary): Promise<void>;
  seal(reason: PrivacyFailure): Promise<void>;
  finalize(): Promise<void>;
  state(): { status: "active" | "prepared" | "suspended" | "isolated" | "sealed" | "finalized" };
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

export class VeilRuntimeCoordinator {
  private currentState: PrivacyState = "normal";
  private operationId: string | undefined;
  private preparation: PrivacyPreparation | undefined;
  private transition = Promise.resolve();
  private finalized = false;
  private readonly runtime: VeilRuntimeSession;
  private resumeBoundary: SafeResumeBoundary | undefined;

  constructor(
    private readonly collectors: PrivacyCollector[],
    private readonly emit: (event: PrivacyEvent) => Promise<void> = async () => undefined,
    private readonly acknowledgementTimeoutMs = 5_000,
    policyDigest = "legacy-policy-adapter",
    contextIdentity = "executor-runtime",
  ) {
    const names = collectors.map(({ name }) => name);
    if (new Set(names).size !== names.length)
      throw new Error("Privacy collector names must be unique");
    const runtimeCollectors = collectors.map((collector): VeilRuntimeCollector => ({
      id: collector.name,
      transition: async (phase, context) => {
        await this.transitionCollector(collector, phase, context.operationId);
        return acknowledgement(collector.name, phase, context.stateVersion, context.operationId);
      },
    }));
    // Veil owns serialization, transition validity, fail-closed sealing, and finalization.
    this.runtime = new VeilRuntimeSession(
      runtimeCollectors,
      policyDigest,
      contextIdentity,
      async () => undefined,
      acknowledgementTimeoutMs,
    );
  }

  state() {
    return this.currentState;
  }
  isSuppressed() {
    return !["normal"].includes(this.currentState);
  }

  getDecision(channel: EvidenceChannel): CaptureDecision {
    if (
      this.currentState === "sealed" ||
      ["aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(this.currentState)
    )
      return "quarantine";
    if (this.currentState !== "normal") {
      if (
        channel === "video" &&
        this.preparation?.videoMaskEstablished &&
        this.preparation.mode !== "protected_recording_gap"
      )
        return "allow";
      return channel === "event" || channel === "report" || channel === "metadata"
        ? "sanitize"
        : "suppress";
    }
    if (
      [
        "dom",
        "accessibility",
        "console",
        "page_error",
        "network",
        "event",
        "report",
        "metadata",
      ].includes(channel)
    )
      return "sanitize";
    if (channel === "clipboard" || channel === "download") return "suppress";
    return "allow";
  }

  prepare(
    operationId: string,
    preparation: PrivacyPreparation = {
      mode: "protected_recording_gap",
      videoMaskEstablished: false,
    },
  ) {
    return this.serial(async () => {
      this.expect("normal");
      if (this.finalized) throw new PrivacyTransitionError("Privacy gate is finalized");
      this.operationId = operationId;
      this.preparation = preparation;
      await this.setState("arming");
      try {
        await this.runtime.prepare(operationId);
      } catch (error) {
        this.currentState = "sealed";
        await this.emit({ state: "sealed", operationId, code: "COLLECTOR_ARM_FAILED" });
        throw new PrivacyTransitionError(
          `COLLECTOR_ARM_FAILED:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.setState("armed", { acknowledgements: this.collectors.map(({ name }) => name) });
      await this.setState("ready_to_reveal");
    });
  }

  beginProtected() {
    return this.serial(async () => {
      this.expect("ready_to_reveal");
      await this.runtime.beginProtected();
      await this.setState("protected");
    });
  }
  markCaptured() {
    return this.serial(async () => {
      this.expect("protected");
      await this.setState("captured");
    });
  }
  beginSafeBoundary() {
    return this.serial(async () => {
      this.expect("captured");
      await this.setState("establishing_safe_boundary");
    });
  }

  confirmSafeBoundary(boundary: SafeResumeBoundary) {
    return this.serial(async () => {
      this.expect("establishing_safe_boundary");
      await this.setState("safe_to_resume");
      this.resumeBoundary = boundary;
      try {
        await this.runtime.resume();
      } catch (error) {
        this.currentState = "sealed";
        await this.emit({
          state: "sealed",
          ...(this.operationId ? { operationId: this.operationId } : {}),
          code: "COLLECTOR_RESUME_FAILED",
        });
        throw new PrivacyTransitionError(
          `COLLECTOR_RESUME_FAILED:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.setState("normal");
      this.operationId = undefined;
      this.preparation = undefined;
      this.resumeBoundary = undefined;
    });
  }

  seal(reason: PrivacyFailure) {
    return this.serial(() => this.sealInternal(reason));
  }

  terminate(disposition: "aborted" | "continuing_unrecorded" | "restarting_checkpoint") {
    return this.serial(async () => {
      this.expect("sealed");
      await this.setState(disposition);
    });
  }

  finalize() {
    return this.serial(async () => {
      if (this.finalized) return;
      if (
        this.currentState !== "normal" &&
        !["sealed", "aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(
          this.currentState,
        )
      ) {
        await this.sealInternal({ code: "FINALIZED_DURING_PRIVACY_TRANSITION" });
      }
      await this.runtime.finalize();
      this.finalized = true;
    });
  }

  private async sealInternal(reason: PrivacyFailure) {
    if (
      ["sealed", "aborted", "continuing_unrecorded", "restarting_checkpoint"].includes(
        this.currentState,
      )
    )
      return;
    this.currentState = "sealed";
    await this.emit({
      state: "sealed",
      ...(this.operationId ? { operationId: this.operationId } : {}),
      code: reason.code,
      ...(reason.collector ? { collector: reason.collector } : {}),
    });
    await this.runtime.seal(veilFailure(reason));
  }

  private async transitionCollector(
    collector: PrivacyCollector,
    phase: VeilCollectorPhase,
    operationId?: string,
  ) {
    if (phase === "prepare") {
      await collector.arm(operationId!, this.preparation);
      return this.requireCollectorState(collector, "prepared");
    }
    if (phase === "suspend") {
      await collector.suspend();
      return this.requireCollectorState(collector, "suspended");
    }
    if (phase === "isolate") {
      await collector.isolate();
      return this.requireCollectorState(collector, "isolated");
    }
    if (phase === "resume") {
      if (!this.resumeBoundary)
        throw new PrivacyTransitionError("Veil resume requires a verified safe boundary");
      await collector.resume(this.resumeBoundary);
      return this.requireCollectorState(collector, "active");
    }
    if (phase === "seal") {
      await collector.seal({ code: "VEIL_RUNTIME_SEALED" });
      return this.requireCollectorState(collector, "sealed");
    }
    if (phase === "finalize") {
      await collector.finalize();
      return this.requireCollectorState(collector, "finalized");
    }
  }

  private requireCollectorState(
    collector: PrivacyCollector,
    expected: ReturnType<PrivacyCollector["state"]>["status"],
  ) {
    const actual = collector.state().status;
    if (actual !== expected)
      throw new PrivacyTransitionError(
        `VEIL_COLLECTOR_STATE_MISMATCH:${collector.name}:${expected}:${actual}`,
      );
  }

  private async setState(state: PrivacyState, extra: Partial<PrivacyEvent> = {}) {
    this.currentState = state;
    await this.emit({
      state,
      ...(this.operationId ? { operationId: this.operationId } : {}),
      ...extra,
    });
  }

  private expect(expected: PrivacyState) {
    if (this.currentState !== expected)
      throw new PrivacyTransitionError(
        `Expected privacy state ${expected}, received ${this.currentState}`,
      );
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function acknowledgement(
  collectorId: string,
  phase: VeilCollectorPhase,
  stateVersion: number,
  operationId?: string,
): VeilCollectorAcknowledgement {
  return {
    schemaVersion: VEIL_CONTRACT_VERSION,
    collectorId,
    phase,
    stateVersion,
    ...(operationId ? { operationId } : {}),
    acknowledgedAt: new Date().toISOString(),
  };
}

function veilFailure(reason: PrivacyFailure): VeilFailure {
  return {
    schemaVersion: VEIL_CONTRACT_VERSION,
    code: reason.code.startsWith("VEIL_") ? reason.code : `VEIL_${reason.code}`,
    provenance: "runtime",
    retry: "unsafe",
    ...(reason.collector ? { collectorId: reason.collector } : {}),
  };
}
