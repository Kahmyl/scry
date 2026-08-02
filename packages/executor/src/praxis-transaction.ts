import { createHash } from "node:crypto";
import type {
  PraxisAgentReport, PraxisFailure, PraxisFailureProvenance, PraxisLifecycleEvent, PraxisMutationOutcome,
  PraxisPhase, PraxisQualityFinding, PraxisRequest, PraxisResolution, PraxisResult, PraxisRetryDisposition,
  PraxisSafeAction, PraxisSuccess, PraxisTiming, PraxisVerification,
} from "@scry/contracts";
import { ExpectedEffectError, GroundingError } from "./grounding.js";

const linearPhases: PraxisPhase[] = ["created", "observing", "grounding", "resolved", "revalidating", "dispatching", "verifying_local", "verifying_effect", "succeeded"];
const terminalPhases = new Set<PraxisPhase>(["succeeded", "failed", "cancelled", "inconclusive"]);

export class PraxisTransactionStateMachine {
  private current: PraxisPhase = "created";
  phase() { return this.current; }
  transition(next: PraxisPhase) {
    if (terminalPhases.has(this.current)) throw new Error(`PRAXIS_TERMINAL_TRANSITION_REJECTED:${this.current}:${next}`);
    if (terminalPhases.has(next) && next !== "succeeded") { this.current = next; return; }
    const expected = linearPhases[linearPhases.indexOf(this.current) + 1];
    if (next !== expected) throw new Error(`PRAXIS_PHASE_TRANSITION_REJECTED:${this.current}:${next}`);
    this.current = next;
  }
}

export type PraxisAdapterDispatch = { mutationOutcome?: PraxisMutationOutcome };
export interface PraxisTransactionAdapter<TTarget = unknown> {
  observe(request: PraxisRequest, signal: AbortSignal): Promise<void>;
  ground(request: PraxisRequest, signal: AbortSignal): Promise<{ target: TTarget; resolution: PraxisResolution; providerTimings?: PraxisTiming["providerTimings"]; escalationLevel?: number }>;
  revalidate(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<void>;
  armEffect?(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<void>;
  dispatch(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<PraxisAdapterDispatch | void>;
  verifyLocal(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<PraxisVerification["local"]>;
  verifyEffect(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<PraxisVerification["effect"]>;
  qualityFindings?(target: TTarget, request: PraxisRequest): Promise<PraxisQualityFinding[]>;
}

export class PraxisAdapterError extends Error {
  constructor(readonly code: string, readonly options: { provenance?: PraxisFailureProvenance; mutationOutcome?: PraxisMutationOutcome; retry?: PraxisRetryDisposition; safeActions?: PraxisSafeAction[] } = {}) { super(code); this.name = "PraxisAdapterError"; }
}

export class PraxisTransactionCoordinator<TTarget = unknown> {
  constructor(private readonly adapter: PraxisTransactionAdapter<TTarget>, private readonly emit?: (event: PraxisLifecycleEvent) => void | Promise<void>) {}

  async execute(request: PraxisRequest, signal: AbortSignal): Promise<PraxisResult> {
    const state = new PraxisTransactionStateMachine();
    const started = performance.now();
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort("PRAXIS_TRANSACTION_TIMED_OUT"), request.policy.totalTimeoutMs);
    const operationSignal = AbortSignal.any([signal, timeoutController.signal]);
    const durations = new Map<PraxisPhase, number>();
    let target: TTarget | undefined;
    let resolution: PraxisResolution | undefined;
    let dispatchStarted = false;
    let mutationOutcome: PraxisMutationOutcome = "not_started";
    let verification: PraxisVerification = { local: "unknown", effect: "unknown", effectType: request.expectedEffect.type };
    let providerTimings: PraxisTiming["providerTimings"] = [];
    let escalationLevel: number | null = null;
    try {
      await this.event(request, "praxis.transaction_started", "created", {});
      await this.stage(state, "observing", durations, request, operationSignal, () => this.adapter.observe(request, operationSignal));
      const grounded = await this.stage(state, "grounding", durations, request, operationSignal, () => this.adapter.ground(request, operationSignal));
      target = grounded.target; resolution = grounded.resolution; providerTimings = grounded.providerTimings ?? []; escalationLevel = grounded.escalationLevel ?? null;
      state.transition("resolved"); await this.event(request, "praxis.phase_changed", "resolved", {});
      await this.stage(state, "revalidating", durations, request, operationSignal, async () => { await this.adapter.revalidate(target!, request, operationSignal); await this.adapter.armEffect?.(target!, request, operationSignal); });
      checkAbort(operationSignal);
      state.transition("dispatching"); dispatchStarted = true; await this.event(request, "praxis.phase_changed", "dispatching", {});
      const dispatchStartedAt = performance.now();
      const dispatch = await this.adapter.dispatch(target, request, operationSignal);
      durations.set("dispatching", performance.now() - dispatchStartedAt);
      mutationOutcome = dispatch?.mutationOutcome ?? (mutates(request) ? "unknown" : "not_applied");
      verification.local = await this.stage(state, "verifying_local", durations, request, operationSignal, () => this.adapter.verifyLocal(target!, request, operationSignal));
      if (verification.local === "failed" || verification.local === "unknown") {
        throw unverifiedOutcome("PRAXIS_LOCAL_STATE_NOT_OBSERVED", dispatchStarted);
      }
      verification.effect = await this.stage(state, "verifying_effect", durations, request, operationSignal, () => this.adapter.verifyEffect(target!, request, operationSignal));
      if (verification.effect === "failed" || verification.effect === "unknown") {
        throw unverifiedOutcome("PRAXIS_EXPECTED_EFFECT_NOT_OBSERVED", dispatchStarted);
      }
      if (mutates(request) && mutationOutcome === "unknown") mutationOutcome = "applied";
      let qualityFindings: PraxisQualityFinding[] = [];
      try { qualityFindings = await this.adapter.qualityFindings?.(target, request) ?? []; }
      catch { /* Advisory reporting cannot redefine a verified interaction outcome. */ }
      state.transition("succeeded");
      const timing = timingFrom(durations, performance.now() - started, providerTimings, escalationLevel);
      const report = reportForSuccess(request, resolution, verification, timing, mutationOutcome, qualityFindings);
      const success: PraxisSuccess = { schemaVersion: 1, status: "succeeded", transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), phase: "succeeded", mutationOutcome, resolution, verification, timing, qualityFindings, report };
      await this.event(request, "praxis.transaction_succeeded", "succeeded", { mutationOutcome });
      clearTimeout(timeout);
      return success;
    } catch (error) {
      const timedOut = timeoutController.signal.aborted && !signal.aborted;
      const cancelled = !timedOut && (signal.aborted || error instanceof PraxisCancellationError);
      const status = timedOut ? (dispatchStarted ? "inconclusive" : "failed") : cancelled ? "cancelled" : dispatchStarted && mutationOutcome === "unknown" ? "inconclusive" : "failed";
      const phase = state.phase();
      if (!terminalPhases.has(phase)) state.transition(status);
      const classified = classify(error, dispatchStarted, mutationOutcome, cancelled, timedOut);
      mutationOutcome = classified.mutationOutcome;
      const timing = timingFrom(durations, performance.now() - started, providerTimings, escalationLevel);
      const safeActions = classified.safeActions;
      const report = reportForFailure(request, status, classified, verification, timing, resolution, safeActions);
      const failure: PraxisFailure = { schemaVersion: 1, status, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), phase: state.phase(), code: classified.code, provenance: classified.provenance, retry: classified.retry, mutationOutcome, timing, diagnostics: classified.diagnostics, qualityFindings: [], safeActions, report };
      await this.event(request, "praxis.transaction_failed", state.phase(), { code: classified.code, mutationOutcome });
      clearTimeout(timeout);
      return failure;
    }
  }

  private async stage<T>(state: PraxisTransactionStateMachine, phase: PraxisPhase, durations: Map<PraxisPhase, number>, request: PraxisRequest, signal: AbortSignal, work: () => Promise<T>) {
    checkAbort(signal); state.transition(phase); await this.event(request, "praxis.phase_changed", phase, {}); const started = performance.now();
    try { const result = await work(); checkAbort(signal); return result; }
    finally { durations.set(phase, performance.now() - started); }
  }

  private async event(request: PraxisRequest, type: PraxisLifecycleEvent["type"], phase: PraxisPhase, payload: PraxisLifecycleEvent["payload"]) {
    try { await this.emit?.({ schemaVersion: 1, transactionId: request.transactionId, operationId: request.operationId, type, phase, occurredAt: new Date().toISOString(), payload }); }
    catch { /* Milestone 1 events are internal observers and cannot redefine interaction truth. */ }
  }
}

class PraxisCancellationError extends Error { constructor() { super("PRAXIS_CANCELLED"); } }
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new PraxisCancellationError(); }
function mutates(request: PraxisRequest) { return ["activate", "enter_text", "select_option", "set_checked", "press_key"].includes(request.operation.type); }
function unverifiedOutcome(code: string, dispatchStarted: boolean) { return new PraxisAdapterError(code, { provenance: "application", mutationOutcome: dispatchStarted ? "unknown" : "not_applied", retry: "unsafe", safeActions: ["do_not_retry", "inspect_artifact"] }); }
function intentDigest(request: PraxisRequest) { return createHash("sha256").update(stable(request.intent)).digest("hex"); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
function timingFrom(durations: Map<PraxisPhase, number>, totalMs: number, providerTimings: PraxisTiming["providerTimings"], escalationLevel: number|null): PraxisTiming { return { queuedMs: null, observationMs: value(durations,"observing"), groundingMs: value(durations,"grounding"), revalidationMs: value(durations,"revalidating"), dispatchMs: value(durations,"dispatching"), localVerificationMs: value(durations,"verifying_local"), effectVerificationMs: value(durations,"verifying_effect"), totalMs, escalationLevel, providerTimings }; }
function value(map: Map<PraxisPhase, number>, phase: PraxisPhase) { return map.has(phase) ? map.get(phase)! : null; }
function reportForSuccess(request: PraxisRequest, resolution: PraxisResolution, verification: PraxisVerification, timing: PraxisTiming, mutationOutcome: PraxisMutationOutcome, qualityFindings: PraxisQualityFinding[]): PraxisAgentReport { return { schemaVersion: 1, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), outcome: "succeeded", summary: "Praxis completed and verified the interaction.", classification: { provenance: "none", mutationOutcome }, intentDigest: intentDigest(request), resolution, verification, timing, qualityFindings, safeActions: [], artifactRefs: [] }; }
function reportForFailure(request: PraxisRequest, status: "failed"|"cancelled"|"inconclusive", classified: ReturnType<typeof classify>, verification: PraxisVerification, timing: PraxisTiming, resolution: PraxisResolution|undefined, safeActions: PraxisSafeAction[]): PraxisAgentReport { return { schemaVersion: 1, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), outcome: status, summary: status === "cancelled" ? "Praxis cancelled the interaction." : "Praxis could not establish a verified interaction outcome.", classification: { provenance: classified.provenance, code: classified.code, mutationOutcome: classified.mutationOutcome }, intentDigest: intentDigest(request), ...(resolution ? { resolution } : {}), verification, timing, qualityFindings: [], safeActions, artifactRefs: [] }; }
type ClassifiedFailure = { code: string; provenance: PraxisFailureProvenance; retry: PraxisRetryDisposition; mutationOutcome: PraxisMutationOutcome; safeActions: PraxisSafeAction[]; diagnostics: Record<string,string|number|boolean|null> };
function classify(error: unknown, dispatchStarted: boolean, current: PraxisMutationOutcome, cancelled: boolean, timedOut: boolean): ClassifiedFailure {
  if (timedOut) { const mutationOutcome = dispatchStarted ? (current === "not_started" ? "unknown" : current) : "not_started"; return { code: "PRAXIS_TRANSACTION_TIMED_OUT", provenance: "infrastructure", retry: mutationOutcome === "unknown" ? "unsafe" : "safe", mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry"] : ["check_executor_health"], diagnostics: { reasonCode: "TOTAL_TIMEOUT" } }; }
  if (cancelled) { const mutationOutcome = dispatchStarted ? (current === "not_started" ? "unknown" : current) : "not_started"; return { code: "PRAXIS_CANCELLED", provenance: "cancelled" as const, retry: mutationOutcome === "unknown" ? "unsafe" as const : "safe" as const, mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry" as const] : ["retry_after_render" as const], diagnostics: { reasonCode: "ABORT_SIGNAL" } }; }
  if (error instanceof PraxisAdapterError) { const mutationOutcome = error.options.mutationOutcome ?? (dispatchStarted ? "unknown" : "not_started"); return { code: error.code, provenance: error.options.provenance ?? "praxis" as const, retry: error.options.retry ?? (mutationOutcome === "unknown" ? "unsafe" as const : "requires_reobservation" as const), mutationOutcome, safeActions: error.options.safeActions ?? (mutationOutcome === "unknown" ? ["do_not_retry" as const] : ["reobserve" as const]), diagnostics: { reasonCode: error.code } }; }
  if (error instanceof GroundingError) { const allowed = new Set<string>(["narrow_scope","revise_intent","retry_after_render","request_calibration","check_executor_health","use_supported_capability"]); const safeActions = error.diagnostic.safeActions.filter((item) => allowed.has(item)) as PraxisSafeAction[]; return { code: `PRAXIS_${error.code}`, provenance: ["INSUFFICIENT_EVIDENCE","TARGET_AMBIGUOUS","TARGET_SCOPE_INVALID"].includes(error.code) ? "intent" as const : error.code === "OBSERVATION_FAILED" ? "infrastructure" as const : "praxis" as const, retry: error.code === "TARGET_CHANGED_BEFORE_ACTION" ? "requires_reobservation" as const : "requires_revision" as const, mutationOutcome: dispatchStarted ? "unknown" as const : "not_started" as const, safeActions, diagnostics: { reasonCode: error.code } }; }
  if (error instanceof ExpectedEffectError) return { code: `PRAXIS_${error.code}`, provenance: "application" as const, retry: "unsafe" as const, mutationOutcome: "unknown" as const, safeActions: ["do_not_retry" as const, "inspect_artifact" as const], diagnostics: { reasonCode: error.code } };
  return { code: "PRAXIS_INTERNAL_ERROR", provenance: "infrastructure" as const, retry: dispatchStarted ? "unsafe" as const : "safe" as const, mutationOutcome: dispatchStarted ? "unknown" as const : "not_started" as const, safeActions: dispatchStarted ? ["do_not_retry" as const] : ["check_executor_health" as const], diagnostics: { reasonCode: error instanceof Error ? error.name.replace(/[^A-Z0-9_]/gi,"_").toUpperCase().slice(0,100) : "UNKNOWN" } };
}
