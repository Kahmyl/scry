import { createHash } from "node:crypto";
import type {
  PraxisAgentReport, PraxisFailure, PraxisFailureProvenance, PraxisLifecycleEvent, PraxisMutationOutcome,
  PraxisPhase, PraxisQualityFinding, PraxisRequest, PraxisResolution, PraxisResult, PraxisRetryDisposition,
  PraxisAcquisitionOutput, PraxisSafeAction, PraxisSuccess, PraxisTiming, PraxisVerification,
} from "@scry/contracts";
import { ExpectedEffectError, GroundingError } from "./grounding.js";
import { PraxisExecutionEnvelope } from "./praxis-execution-envelope.js";

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

export type PraxisAdapterDispatch<TTarget = unknown> = { mutationOutcome?: PraxisMutationOutcome; output?: PraxisAcquisitionOutput; target?: TTarget; resolution?: PraxisResolution; providerTimings?: PraxisTiming["providerTimings"]; escalationLevel?: number };
export class PraxisDispatchBoundary {
  #dispatchEntered = false;
  #mutationStarted = false;
  constructor(private readonly mutating: boolean) {}
  enterDispatch() { if (this.#dispatchEntered) throw new Error("PRAXIS_DISPATCH_BOUNDARY_REENTERED"); this.#dispatchEntered = true; }
  beginMutation() {
    if (!this.#dispatchEntered) throw new Error("PRAXIS_MUTATION_BEFORE_DISPATCH");
    if (!this.mutating) throw new Error("PRAXIS_READ_ONLY_MUTATION_REJECTED");
    if (this.#mutationStarted) throw new Error("PRAXIS_MUTATION_BOUNDARY_REPEATED");
    this.#mutationStarted = true;
  }
  dispatchEntered() { return this.#dispatchEntered; }
  mutationStarted() { return this.#mutationStarted; }
  failureOutcome(current: PraxisMutationOutcome): PraxisMutationOutcome {
    if (this.#mutationStarted) return current === "not_started" || current === "not_applied" ? "unknown" : current;
    return this.#dispatchEntered && this.mutating ? "not_applied" : "not_started";
  }
}
export interface PraxisTransactionAdapter<TTarget = unknown> {
  acquire?(request: PraxisRequest, signal: AbortSignal): Promise<() => void>;
  observe(request: PraxisRequest, signal: AbortSignal): Promise<void>;
  ground(request: PraxisRequest, signal: AbortSignal): Promise<{ target: TTarget; resolution: PraxisResolution; providerTimings?: PraxisTiming["providerTimings"]; escalationLevel?: number }>;
  revalidate(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<void | { target: TTarget; resolution: PraxisResolution; providerTimings?: PraxisTiming["providerTimings"]; escalationLevel?: number }>;
  armEffect?(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<void>;
  dispatch(target: TTarget, request: PraxisRequest, signal: AbortSignal, boundary: PraxisDispatchBoundary): Promise<PraxisAdapterDispatch<TTarget> | void>;
  verifyLocal(target: TTarget, request: PraxisRequest, signal: AbortSignal): Promise<PraxisVerification["local"]>;
  verifyEffect(target: TTarget, request: PraxisRequest, signal: AbortSignal, budgetMs: number): Promise<PraxisVerification["effect"]>;
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
    const deadline = started + request.policy.totalTimeoutMs;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort("PRAXIS_TRANSACTION_TIMED_OUT"), request.policy.totalTimeoutMs);
    const operationSignal = AbortSignal.any([signal, timeoutController.signal]);
    const durations = new Map<PraxisPhase, number>();
    let target: TTarget | undefined;
    let resolution: PraxisResolution | undefined;
    const dispatchBoundary = new PraxisDispatchBoundary(mutates(request));
    let mutationOutcome: PraxisMutationOutcome = "not_started";
    let verification: PraxisVerification = { local: "unknown", effect: "unknown", effectType: request.expectedEffect.type };
    let providerTimings: PraxisTiming["providerTimings"] = [];
    let escalationLevel: number | null = null;
    let output: PraxisAcquisitionOutput | undefined;
    let release: () => void = () => undefined;
    try {
      await this.event(request, "praxis.transaction_started", "created", {});
      const queuedAt = performance.now();
      release = await this.adapter.acquire?.(request, operationSignal) ?? release;
      durations.set("created", performance.now() - queuedAt);
      await this.stage(state, "observing", durations, request, operationSignal, () => this.adapter.observe(request, operationSignal));
      const grounded = await this.stage(state, "grounding", durations, request, operationSignal, () => this.adapter.ground(request, operationSignal));
      target = grounded.target; resolution = grounded.resolution; providerTimings = grounded.providerTimings ?? []; escalationLevel = grounded.escalationLevel ?? null;
      state.transition("resolved"); await this.event(request, "praxis.phase_changed", "resolved", {});
      await this.stage(state, "revalidating", durations, request, operationSignal, async () => {
        const refreshed = await this.adapter.revalidate(target!, request, operationSignal);
        if (refreshed) { target = refreshed.target; resolution = refreshed.resolution; providerTimings = [...providerTimings, ...(refreshed.providerTimings ?? [])]; escalationLevel = Math.max(escalationLevel ?? 0, refreshed.escalationLevel ?? 0) || null; }
        await this.adapter.armEffect?.(target!, request, operationSignal);
      });
      checkAbort(operationSignal);
      state.transition("dispatching"); dispatchBoundary.enterDispatch(); await this.event(request, "praxis.phase_changed", "dispatching", {});
      const dispatchPhaseStartedAt = performance.now();
      const dispatch = await this.adapter.dispatch(target, request, operationSignal, dispatchBoundary);
      if (mutates(request) && !dispatchBoundary.mutationStarted()) throw new Error("PRAXIS_MUTATION_BOUNDARY_NOT_RECORDED");
      output = dispatch?.output;
      if (dispatch?.target) target = dispatch.target;
      if (dispatch?.resolution) resolution = dispatch.resolution;
      if (dispatch?.providerTimings) providerTimings = [...providerTimings, ...dispatch.providerTimings];
      if (dispatch?.escalationLevel !== undefined) escalationLevel = Math.max(escalationLevel ?? 0, dispatch.escalationLevel) || null;
      durations.set("dispatching", performance.now() - dispatchPhaseStartedAt);
      mutationOutcome = dispatch?.mutationOutcome ?? (mutates(request) ? "unknown" : "not_applied");
      verification.local = await this.stage(state, "verifying_local", durations, request, operationSignal, () => this.adapter.verifyLocal(target!, request, operationSignal));
      if (verification.local === "failed" || verification.local === "unknown") {
        throw unverifiedOutcome("PRAXIS_LOCAL_STATE_NOT_OBSERVED");
      }
      verification.effect = await this.stage(state, "verifying_effect", durations, request, operationSignal, () => this.adapter.verifyEffect(target!, request, operationSignal, PraxisExecutionEnvelope.verificationBudget(deadline, request.policy.actionTimeoutMs)));
      if (verification.effect === "failed" || verification.effect === "unknown") {
        throw unverifiedOutcome("PRAXIS_EXPECTED_EFFECT_NOT_OBSERVED");
      }
      if (mutates(request) && mutationOutcome === "unknown") mutationOutcome = "applied";
      let qualityFindings: PraxisQualityFinding[] = [];
      try { qualityFindings = await this.adapter.qualityFindings?.(target, request) ?? []; }
      catch { /* Advisory reporting cannot redefine a verified interaction outcome. */ }
      state.transition("succeeded");
      const timing = timingFrom(durations, performance.now() - started, providerTimings, escalationLevel);
      const report = reportForSuccess(request, resolution, verification, timing, mutationOutcome, qualityFindings);
      const success: PraxisSuccess = { schemaVersion: 1, status: "succeeded", transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), phase: "succeeded", mutationOutcome, resolution, verification, timing, ...(output ? { output } : {}), qualityFindings, report };
      await this.event(request, "praxis.transaction_succeeded", "succeeded", { mutationOutcome });
      return success;
    } catch (error) {
      const timedOut = timeoutController.signal.aborted && !signal.aborted;
      const cancelled = !timedOut && (signal.aborted || error instanceof PraxisCancellationError);
      const classified = classify(error, dispatchBoundary, mutationOutcome, cancelled, timedOut);
      const status = timedOut ? (classified.mutationOutcome === "unknown" ? "inconclusive" : "failed") : cancelled ? "cancelled" : classified.mutationOutcome === "unknown" ? "inconclusive" : "failed";
      const phase = state.phase();
      if (!terminalPhases.has(phase)) state.transition(status);
      mutationOutcome = classified.mutationOutcome;
      const timing = timingFrom(durations, performance.now() - started, providerTimings, escalationLevel);
      const safeActions = classified.safeActions;
      const report = reportForFailure(request, status, classified, verification, timing, resolution, safeActions);
      const failure: PraxisFailure = { schemaVersion: 1, status, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), phase: state.phase(), code: classified.code, provenance: classified.provenance, retry: classified.retry, mutationOutcome, timing, diagnostics: classified.diagnostics, qualityFindings: [], safeActions, report };
      await this.event(request, "praxis.transaction_failed", state.phase(), { code: classified.code, mutationOutcome });
      return failure;
    } finally {
      release();
      clearTimeout(timeout);
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
function unverifiedOutcome(code: string) { return new PraxisAdapterError(code, { provenance: "application", safeActions: ["inspect_artifact"] }); }
function intentDigest(request: PraxisRequest) { return createHash("sha256").update(stable(request.intent)).digest("hex"); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
function timingFrom(durations: Map<PraxisPhase, number>, totalMs: number, providerTimings: PraxisTiming["providerTimings"], escalationLevel: number|null): PraxisTiming { return { queuedMs: value(durations,"created"), observationMs: value(durations,"observing"), groundingMs: value(durations,"grounding"), revalidationMs: value(durations,"revalidating"), dispatchMs: value(durations,"dispatching"), localVerificationMs: value(durations,"verifying_local"), effectVerificationMs: value(durations,"verifying_effect"), totalMs, escalationLevel, providerTimings }; }
function value(map: Map<PraxisPhase, number>, phase: PraxisPhase) { return map.has(phase) ? map.get(phase)! : null; }
function reportForSuccess(request: PraxisRequest, resolution: PraxisResolution, verification: PraxisVerification, timing: PraxisTiming, mutationOutcome: PraxisMutationOutcome, qualityFindings: PraxisQualityFinding[]): PraxisAgentReport { return { schemaVersion: 1, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), outcome: "succeeded", summary: "Praxis completed and verified the interaction.", classification: { provenance: "none", mutationOutcome }, intentDigest: intentDigest(request), resolution, verification, timing, qualityFindings, safeActions: [], artifactRefs: [] }; }
function reportForFailure(request: PraxisRequest, status: "failed"|"cancelled"|"inconclusive", classified: ReturnType<typeof classify>, verification: PraxisVerification, timing: PraxisTiming, resolution: PraxisResolution|undefined, safeActions: PraxisSafeAction[]): PraxisAgentReport { return { schemaVersion: 1, transactionId: request.transactionId, operationId: request.operationId, ...(request.stepId ? { stepId: request.stepId } : {}), outcome: status, summary: status === "cancelled" ? "Praxis cancelled the interaction." : "Praxis could not establish a verified interaction outcome.", classification: { provenance: classified.provenance, code: classified.code, mutationOutcome: classified.mutationOutcome }, intentDigest: intentDigest(request), ...(resolution ? { resolution } : {}), verification, timing, qualityFindings: [], safeActions, artifactRefs: [] }; }
type ClassifiedFailure = { code: string; provenance: PraxisFailureProvenance; retry: PraxisRetryDisposition; mutationOutcome: PraxisMutationOutcome; safeActions: PraxisSafeAction[]; diagnostics: Record<string,string|number|boolean|null> };
function classify(error: unknown, boundary: PraxisDispatchBoundary, current: PraxisMutationOutcome, cancelled: boolean, timedOut: boolean): ClassifiedFailure {
  const mutationOutcome = boundary.failureOutcome(current);
  if (timedOut) return { code: "PRAXIS_TRANSACTION_TIMED_OUT", provenance: "infrastructure", retry: mutationOutcome === "unknown" ? "unsafe" : "safe", mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry"] : ["check_executor_health"], diagnostics: failureDiagnostics("TOTAL_TIMEOUT", boundary) };
  if (cancelled) return { code: "PRAXIS_CANCELLED", provenance: "cancelled" as const, retry: mutationOutcome === "unknown" ? "unsafe" as const : "safe" as const, mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry" as const] : ["retry_after_render" as const], diagnostics: failureDiagnostics("ABORT_SIGNAL", boundary) };
  if (error instanceof PraxisAdapterError) return { code: error.code, provenance: error.options.provenance ?? "praxis" as const, retry: mutationOutcome === "unknown" ? "unsafe" as const : error.options.retry ?? "requires_reobservation" as const, mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry" as const] : error.options.safeActions ?? ["reobserve" as const], diagnostics: failureDiagnostics(error.code, boundary) };
  if (error instanceof GroundingError) { const allowed = new Set<string>(["narrow_scope","revise_intent","retry_after_render","request_calibration","check_executor_health","use_supported_capability"]); const safeActions = error.diagnostic.safeActions.filter((item) => allowed.has(item)) as PraxisSafeAction[]; return { code: `PRAXIS_${error.code}`, provenance: ["INSUFFICIENT_EVIDENCE","TARGET_AMBIGUOUS","TARGET_SCOPE_INVALID"].includes(error.code) ? "intent" as const : error.code === "OBSERVATION_FAILED" ? "infrastructure" as const : "praxis" as const, retry: error.code === "TARGET_CHANGED_BEFORE_ACTION" ? "requires_reobservation" as const : "requires_revision" as const, mutationOutcome, safeActions, diagnostics: failureDiagnostics(error.code, boundary) }; }
  if (error instanceof ExpectedEffectError) return { code: `PRAXIS_${error.code}`, provenance: "application" as const, retry: mutationOutcome === "unknown" ? "unsafe" as const : "requires_reobservation" as const, mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry" as const, "inspect_artifact" as const] : ["reobserve" as const], diagnostics: failureDiagnostics(error.code, boundary) };
  return { code: "PRAXIS_INTERNAL_ERROR", provenance: "infrastructure" as const, retry: mutationOutcome === "unknown" ? "unsafe" as const : "safe" as const, mutationOutcome, safeActions: mutationOutcome === "unknown" ? ["do_not_retry" as const] : ["check_executor_health" as const], diagnostics: failureDiagnostics(error instanceof Error ? error.name.replace(/[^A-Z0-9_]/gi,"_").toUpperCase().slice(0,100) : "UNKNOWN", boundary) };
}
function failureDiagnostics(reasonCode: string, boundary: PraxisDispatchBoundary) { return { reasonCode, mutationBoundaryCrossed: boundary.mutationStarted() }; }
