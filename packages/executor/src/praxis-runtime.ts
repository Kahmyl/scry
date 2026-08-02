import type { PraxisMutationOutcome, PraxisOperation, PraxisRequest, PraxisResolution, PraxisVerification } from "@scry/contracts";
import type { Locator, Page } from "playwright";
import { armExpectedEffect, resolveTarget, verifyExpectedEffect, type GroundingResult } from "./grounding.js";
import { PRAXIS_PROVIDER_CATALOG, PraxisDocumentEpoch, PraxisObservationCache, PraxisStaleTargetError, PraxisTargetHandle, observationIdentity, type PraxisProviderTiming } from "./praxis-observation.js";
import { PraxisAdapterError } from "./praxis-transaction.js";

export type PraxisStrategy =
  | "native_activate" | "native_fill" | "native_select" | "native_check"
  | "computed_activate" | "focus_keyboard" | "content_editable"
  | "verified_pointer" | "canvas_coordinate" | "scroll" | "inspect" | "application_adapter";

export class PraxisGroundedTarget {
  readonly handle: PraxisTargetHandle;
  readonly resolution: PraxisResolution;
  readonly strategy: PraxisStrategy;
  readonly beforeUrl: string;
  readonly providerTimings: readonly PraxisProviderTiming[];
  #grounded: GroundingResult;
  #armed: Promise<void> | undefined;

  constructor(page: Page, grounded: GroundingResult, epoch: number, resolution: PraxisResolution, strategy: PraxisStrategy, providerTimings: readonly PraxisProviderTiming[]) {
    this.handle = new PraxisTargetHandle(page, grounded.locator, epoch);
    this.resolution = resolution;
    this.strategy = strategy;
    this.beforeUrl = page.url();
    this.providerTimings = providerTimings;
    this.#grounded = grounded;
  }
  groundingDiagnostic() { return this.#grounded.diagnostic; }
  actionPoint() { return this.#grounded.actionPoint; }
  arm(value: Promise<void> | undefined) { this.#armed = value; }
  armed() { return this.#armed; }
  async legacyRevalidate() { await this.#grounded.revalidate(); }
  toJSON() { return { handle: this.handle, resolution: this.resolution, strategy: this.strategy, beforeUrl: this.beforeUrl }; }
}

export class PraxisGroundingEngine {
  constructor(private readonly page: Page) {}
  async resolve(request: PraxisRequest, signal: AbortSignal) {
    checkAbort(signal);
    const started = performance.now();
    const grounded = await resolveTarget(this.page, request.intent);
    checkAbort(signal);
    const epoch = await PraxisDocumentEpoch.current(this.page);
    const fingerprint = grounded.diagnostic.selectedFingerprint!;
    const strategy = selectPraxisStrategy(request.operation, grounded.adapter);
    const resolution: PraxisResolution = {
      target: { fingerprint: fingerprint.digest, concept: fingerprint.concept, scopeKind: fingerprint.scopeKind, capabilityDigest: fingerprint.capabilityDigest },
      confidence: grounded.diagnostic.confidence,
      runnerUpMargin: grounded.diagnostic.confidenceMargin,
      evidenceFamilies: grounded.diagnostic.evidenceFamilies ?? [],
      drift: grounded.diagnostic.drift,
      strategy: grounded.adapter,
    };
    const providerTimings = [{ provider: "legacy-unified-grounding", durationMs: performance.now() - started, outcome: "succeeded" as const }];
    const providerIds = PRAXIS_PROVIDER_CATALOG.map((provider) => `${provider.id}@${provider.version}`);
    const cacheKey = PraxisObservationCache.key({ scope: request.intent.scope, privacyState: request.privacy.state, providers: providerIds, epoch });
    PraxisObservationCache.set(this.page, cacheKey, { ...observationIdentity(this.page, request.intent.scope, request.privacy.state, epoch), controls: [{ runtimeId: fingerprint.digest, fingerprint: fingerprint.digest, capabilitiesDigest: fingerprint.capabilityDigest, evidence: [] }], providerTimings });
    return new PraxisGroundedTarget(this.page, grounded, epoch, resolution, strategy, providerTimings);
  }
}

export function selectPraxisStrategy(operation: PraxisOperation, adapter: GroundingResult["adapter"]): PraxisStrategy {
  if (operation.type === "inspect" || operation.type === "read_value" || operation.type === "wait_for_state") return "inspect";
  if (operation.type === "scroll") return "scroll";
  if (adapter === "native_fill") return "native_fill";
  if (adapter === "native_select") return "native_select";
  if (adapter === "native_check") return "native_check";
  if (adapter === "focus_keyboard") return "focus_keyboard";
  if (adapter === "content_editable") return "content_editable";
  if (adapter === "canvas_coordinate") return "canvas_coordinate";
  if (adapter === "application_adapter") return "application_adapter";
  return operation.type === "activate" ? "native_activate" : "computed_activate";
}

type Release = () => void;
const pageMutationTails = new WeakMap<Page, Promise<void>>();
export class PraxisMutationLease {
  static async acquire(page: Page, signal: AbortSignal): Promise<Release> {
    const previous = pageMutationTails.get(page) ?? Promise.resolve();
    let release!: Release;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pageMutationTails.set(page, previous.then(() => current));
    await Promise.race([previous, abortPromise(signal)]);
    if (signal.aborted) { release(); throw new PraxisDispatchCancellation(); }
    let finished = false;
    return () => { if (finished) return; finished = true; release(); };
  }
}

export class PraxisDispatcher {
  constructor(private readonly page: Page, private readonly resolveInput: (reference: string, classification: "public"|"known_secret"|"captured_secret"|"captured_public") => Promise<string>) {}
  async dispatch(target: PraxisGroundedTarget, request: PraxisRequest, signal: AbortSignal): Promise<{ mutationOutcome: PraxisMutationOutcome }> {
    checkAbort(signal);
    const mutating = isMutating(request.operation);
    const release = mutating ? await PraxisMutationLease.acquire(this.page, signal) : () => undefined;
    let browserControlStarted = false;
    try {
      await target.handle.use(async (locator) => {
        checkAbort(signal);
        browserControlStarted = mutating;
        await dispatchOperation(this.page, locator, target, request, this.resolveInput);
      });
      return { mutationOutcome: mutating ? "unknown" : "not_applied" };
    } catch (error) {
      if (error instanceof PraxisStaleTargetError) throw new PraxisAdapterError("PRAXIS_TARGET_CHANGED_BEFORE_ACTION", { provenance: "application", retry: "requires_reobservation", mutationOutcome: "not_applied", safeActions: ["reobserve"] });
      if (signal.aborted || error instanceof PraxisDispatchCancellation) throw new PraxisAdapterError("PRAXIS_CANCELLED", { provenance: "cancelled", retry: browserControlStarted ? "unsafe" : "safe", mutationOutcome: browserControlStarted ? "unknown" : "not_applied", safeActions: browserControlStarted ? ["do_not_retry"] : ["retry_after_render"] });
      if (error instanceof PraxisAdapterError) throw error;
      throw new PraxisAdapterError("PRAXIS_DISPATCH_FAILED", { provenance: "application", retry: browserControlStarted ? "unsafe" : "requires_reobservation", mutationOutcome: browserControlStarted ? "unknown" : "not_applied", safeActions: browserControlStarted ? ["do_not_retry"] : ["reobserve"] });
    } finally { release(); }
  }
}

export class PraxisVerifier {
  constructor(private readonly page: Page, private readonly resolveInput: (reference: string, classification: "public"|"known_secret"|"captured_secret"|"captured_public") => Promise<string>) {}
  armEffect(target: PraxisGroundedTarget, request: PraxisRequest) { target.arm(armExpectedEffect(this.page, request.expectedEffect, request.policy.actionTimeoutMs)); }
  async local(target: PraxisGroundedTarget, request: PraxisRequest): Promise<PraxisVerification["local"]> {
    if (!["enter_text", "select_option", "set_checked", "wait_for_state"].includes(request.operation.type)) return "not_required";
    return target.handle.readAfterDispatch(async (locator) => {
      if (request.operation.type === "enter_text") return await readableValue(locator) === await this.resolveInput(request.operation.input.reference, request.operation.input.classification) ? "passed" : "failed";
      if (request.operation.type === "select_option") return await locator.inputValue() === await this.resolveInput(request.operation.input.reference, request.operation.input.classification) ? "passed" : "failed";
      if (request.operation.type === "set_checked") return await locator.isChecked() === request.operation.checked ? "passed" : "failed";
      if (request.operation.type === "wait_for_state") return await verifyWaitState(locator, request.operation.state) ? "passed" : "failed";
      return "not_required";
    });
  }
  async effect(target: PraxisGroundedTarget, request: PraxisRequest): Promise<PraxisVerification["effect"]> { if (request.expectedEffect.type === "none") return "not_required"; await verifyExpectedEffect(this.page, request.expectedEffect, target.beforeUrl, request.policy.actionTimeoutMs, target.armed()); return "passed"; }
}

async function dispatchOperation(page: Page, locator: Locator, target: PraxisGroundedTarget, request: PraxisRequest, resolveInput: PraxisDispatcher["resolveInput"]) {
  const options = { timeout: request.policy.actionTimeoutMs };
  switch (request.operation.type) {
    case "activate": { const point = target.actionPoint(); await locator.click(target.strategy === "canvas_coordinate" && point ? { ...options, position: point } : options); break; }
    case "enter_text": { const value = await resolveInput(request.operation.input.reference, request.operation.input.classification); if (target.strategy === "native_fill") await locator.fill(value, options); else { await locator.focus(options); if (target.strategy === "content_editable") await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A", options); await page.keyboard.insertText(value); } break; }
    case "select_option": await locator.selectOption(await resolveInput(request.operation.input.reference, request.operation.input.classification), options); break;
    case "set_checked": await locator.setChecked(request.operation.checked, options); break;
    case "press_key": await locator.press(request.operation.key, options); break;
    case "wait_for_state": if (["visible","hidden","attached","detached"].includes(request.operation.state)) await locator.waitFor({ state: request.operation.state as "visible"|"hidden"|"attached"|"detached", ...options }); else if (!await verifyWaitState(locator, request.operation.state)) throw new PraxisAdapterError("PRAXIS_LOCAL_STATE_NOT_OBSERVED", { provenance: "application", mutationOutcome: "not_applied" }); break;
    case "scroll": if (request.operation.direction === "into_view") await locator.scrollIntoViewIfNeeded(options); else await locator.evaluate((element, direction) => element.scrollBy({ top: direction === "down" ? element.clientHeight : direction === "up" ? -element.clientHeight : 0, left: direction === "right" ? element.clientWidth : direction === "left" ? -element.clientWidth : 0 }), request.operation.direction); break;
    case "read_value": case "inspect": break;
  }
}
function isMutating(operation: PraxisOperation) { return ["activate", "enter_text", "select_option", "set_checked", "press_key"].includes(operation.type); }
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new PraxisDispatchCancellation(); }
function abortPromise(signal: AbortSignal) { return new Promise<never>((_, reject) => { if (signal.aborted) reject(new PraxisDispatchCancellation()); else signal.addEventListener("abort", () => reject(new PraxisDispatchCancellation()), { once: true }); }); }
class PraxisDispatchCancellation extends Error {}
async function readableValue(locator: Locator) { return locator.inputValue().catch(() => locator.textContent().then((value) => value ?? "")); }
async function verifyWaitState(locator: Locator, state: "visible"|"hidden"|"attached"|"detached"|"enabled"|"disabled") { if (state === "visible") return locator.isVisible(); if (state === "hidden") return !(await locator.isVisible()); if (state === "enabled") return locator.isEnabled(); if (state === "disabled") return !(await locator.isEnabled()); const count = await locator.count(); return state === "attached" ? count > 0 : count === 0; }
