import type { PraxisRequest, PraxisVerification } from "@scry/contracts";
import type { Page } from "playwright";
import { PraxisDispatcher, PraxisGroundingEngine, PraxisMutationLease, type PraxisGroundedTarget, PraxisVerifier } from "./praxis-runtime.js";
import { PraxisStaleTargetError } from "./praxis-observation.js";
import { GroundingError } from "./grounding.js";
import { analyzePraxisQuality } from "./praxis-quality.js";
import { PraxisAdapterError, type PraxisDispatchBoundary, type PraxisTransactionAdapter } from "./praxis-transaction.js";
import { PraxisAdmissionError, PraxisExecutionEnvelope } from "./praxis-execution-envelope.js";

export type PraxisInputResolver = (reference: string, classification: "public"|"known_secret"|"captured_secret"|"captured_public") => Promise<string>;

export class PraxisAdapter implements PraxisTransactionAdapter<PraxisGroundedTarget> {
  private readonly grounding: PraxisGroundingEngine;
  private readonly dispatcher: PraxisDispatcher;
  private readonly verifier: PraxisVerifier;
  private readonly reobservedTransactions = new Set<string>();

  constructor(private readonly page: Page, private readonly resolveInput: PraxisInputResolver = async () => {
    throw new PraxisAdapterError("PRAXIS_INPUT_UNAVAILABLE", { provenance: "environment", retry: "requires_revision", mutationOutcome: "not_started" });
  }) {
    this.grounding = new PraxisGroundingEngine(page);
    this.dispatcher = new PraxisDispatcher(page, resolveInput);
    this.verifier = new PraxisVerifier(page, resolveInput);
  }

  async acquire(request: PraxisRequest, signal: AbortSignal) {
    return PraxisMutationLease.acquireFor(request.operation, this.page, signal);
  }

  async observe(request: PraxisRequest) {
    try { PraxisExecutionEnvelope.admit(this.page, request); }
    catch (error) {
      if (!(error instanceof PraxisAdmissionError)) throw error;
      const privacy = error.code === "PRAXIS_REQUIRED_CHANNEL_FORBIDDEN";
      throw new PraxisAdapterError(error.code, { provenance: privacy ? "privacy" : "policy", retry: "requires_revision", mutationOutcome: "not_started", safeActions: privacy ? ["request_authorization", "revise_intent"] : ["request_authorization"] });
    }
  }
  async ground(request: PraxisRequest, signal: AbortSignal) { const target = await this.grounding.resolve(request, signal); return { target, resolution: target.resolution, providerTimings: [...target.providerTimings], escalationLevel: target.escalationLevel }; }
  async revalidate(target: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal) {
    try { await target.handle.reconcile(async () => target.revalidate()); return; }
    catch (error) {
      const changed = error instanceof PraxisStaleTargetError || error instanceof GroundingError && error.code === "TARGET_CHANGED_BEFORE_ACTION";
      if (!changed) throw error;
      try {
        const refreshed = await this.refreshTarget(target, request, signal);
        return { target: refreshed, resolution: refreshed.resolution, providerTimings: [...refreshed.providerTimings], escalationLevel: refreshed.escalationLevel };
      } catch (refreshError) {
        if (!(refreshError instanceof PraxisStaleTargetError) && !(refreshError instanceof GroundingError && refreshError.code === "TARGET_CHANGED_BEFORE_ACTION")) throw refreshError;
        throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", { provenance: "application", retry: "requires_reobservation", mutationOutcome: "not_applied", safeActions: ["reobserve"] });
      }
    }
  }
  async armEffect(target: PraxisGroundedTarget, request: PraxisRequest) { this.verifier.armEffect(target, request); }
  async dispatch(target: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal, boundary: PraxisDispatchBoundary) {
    try { return await this.dispatcher.dispatch(target, request, signal, boundary); }
    catch (error) {
      const changed = error instanceof PraxisAdapterError && error.code === "PRAXIS_TARGET_CHANGED_BEFORE_ACTION";
      if (!changed || boundary.mutationStarted() || this.reobservedTransactions.has(request.transactionId)) throw error;
      const refreshed = await this.refreshTarget(target, request, signal);
      const dispatched = await this.dispatcher.dispatch(refreshed, request, signal, boundary);
      return { ...dispatched, target: refreshed, resolution: refreshed.resolution, providerTimings: [...refreshed.providerTimings], escalationLevel: refreshed.escalationLevel };
    } finally { this.reobservedTransactions.delete(request.transactionId); }
  }
  async verifyLocal(target: PraxisGroundedTarget, request: PraxisRequest): Promise<PraxisVerification["local"]> { return this.verifier.local(target, request); }
  async verifyEffect(target: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal, budgetMs: number): Promise<PraxisVerification["effect"]> { return this.verifier.effect(target, request, signal, budgetMs); }
  async qualityFindings(target: PraxisGroundedTarget, request: PraxisRequest) { return analyzePraxisQuality(target, request); }

  private async refreshTarget(previous: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal) {
    if (this.reobservedTransactions.has(request.transactionId)) throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", { provenance: "application", retry: "requires_reobservation", mutationOutcome: "not_applied", safeActions: ["reobserve"] });
    this.reobservedTransactions.add(request.transactionId);
    try {
      await renderTransitionBoundary(signal);
      const refreshed = await this.grounding.resolve(request, signal);
      refreshed.arm(previous.armed());
      await refreshed.handle.reconcile(async () => refreshed.revalidate());
      return refreshed;
    } catch (error) { this.reobservedTransactions.delete(request.transactionId); throw error; }
  }
}

function renderTransitionBoundary(signal: AbortSignal) { return new Promise<void>((resolve, reject) => { if (signal.aborted) { reject(signal.reason); return; } const aborted=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener("abort",aborted);resolve();},50);signal.addEventListener("abort",aborted,{once:true}); }); }
