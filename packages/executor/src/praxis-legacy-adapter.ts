import type { PraxisRequest, PraxisVerification } from "@scry/contracts";
import type { Page } from "playwright";
import { PraxisDispatcher, PraxisGroundingEngine, type PraxisGroundedTarget, PraxisVerifier } from "./praxis-runtime.js";
import { PraxisStaleTargetError } from "./praxis-observation.js";
import { analyzePraxisQuality } from "./praxis-quality.js";
import { PraxisAdapterError, type PraxisTransactionAdapter } from "./praxis-transaction.js";

export type PraxisInputResolver = (reference: string, classification: "public"|"known_secret"|"captured_secret"|"captured_public") => Promise<string>;

export class LegacyPraxisAdapter implements PraxisTransactionAdapter<PraxisGroundedTarget> {
  private readonly grounding: PraxisGroundingEngine;
  private readonly dispatcher: PraxisDispatcher;
  private readonly verifier: PraxisVerifier;
  constructor(private readonly page: Page, private readonly resolveInput: PraxisInputResolver = async () => { throw new PraxisAdapterError("PRAXIS_INPUT_UNAVAILABLE", { provenance: "environment", retry: "requires_revision", mutationOutcome: "not_started" }); }) {
    this.grounding = new PraxisGroundingEngine(page);
    this.dispatcher = new PraxisDispatcher(page, resolveInput);
    this.verifier = new PraxisVerifier(page, resolveInput);
  }
  async observe() { /* Observation is bounded by the unified grounding engine in Milestone 2. */ }
  async ground(request: PraxisRequest, signal: AbortSignal) { const target = await this.grounding.resolve(request, signal); return { target, resolution: target.resolution, providerTimings: [...target.providerTimings] }; }
  async revalidate(target: PraxisGroundedTarget) { try { await target.handle.use(async () => target.legacyRevalidate()); } catch (error) { if (error instanceof PraxisStaleTargetError) throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", { provenance: "application", retry: "requires_reobservation", mutationOutcome: "not_applied", safeActions: ["reobserve"] }); throw error; } }
  async armEffect(target: PraxisGroundedTarget, request: PraxisRequest) { this.verifier.armEffect(target, request); }
  async dispatch(target: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal) { return this.dispatcher.dispatch(target, request, signal); }
  async verifyLocal(target: PraxisGroundedTarget, request: PraxisRequest): Promise<PraxisVerification["local"]> { return this.verifier.local(target, request); }
  async verifyEffect(target: PraxisGroundedTarget, request: PraxisRequest): Promise<PraxisVerification["effect"]> { return this.verifier.effect(target, request); }
  async qualityFindings(target: PraxisGroundedTarget, request: PraxisRequest) { return analyzePraxisQuality(target, request); }
}
