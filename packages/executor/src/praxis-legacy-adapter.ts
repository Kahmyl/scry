import type { PraxisRequest, PraxisResolution, PraxisVerification } from "@scry/contracts";
import type { Page } from "playwright";
import { armExpectedEffect, resolveTarget, verifyExpectedEffect, type GroundingResult } from "./grounding.js";
import { PraxisAdapterError, type PraxisTransactionAdapter } from "./praxis-transaction.js";

type LegacyTarget = { grounded: GroundingResult; beforeUrl: string; armed: Promise<void> | undefined };
export type PraxisInputResolver = (reference: string, classification: "public"|"known_secret"|"captured_secret"|"captured_public") => Promise<string>;

export class LegacyPraxisAdapter implements PraxisTransactionAdapter<LegacyTarget> {
  constructor(private readonly page: Page, private readonly resolveInput: PraxisInputResolver = async () => { throw new PraxisAdapterError("PRAXIS_INPUT_UNAVAILABLE", { provenance: "environment", retry: "requires_revision", mutationOutcome: "not_started" }); }) {}
  async observe() { /* Current resolveTarget owns observation during the compatibility milestone. */ }
  async ground(request: PraxisRequest) {
    const grounded = await resolveTarget(this.page, request.intent);
    const fingerprint = grounded.diagnostic.selectedFingerprint!;
    const resolution: PraxisResolution = { target: { fingerprint: fingerprint.digest, concept: fingerprint.concept, scopeKind: fingerprint.scopeKind, capabilityDigest: fingerprint.capabilityDigest }, confidence: grounded.diagnostic.confidence, runnerUpMargin: grounded.diagnostic.confidenceMargin, evidenceFamilies: grounded.diagnostic.evidenceFamilies ?? [], drift: grounded.diagnostic.drift, strategy: grounded.adapter };
    return { target: { grounded, beforeUrl: this.page.url(), armed: undefined }, resolution };
  }
  async revalidate(target: LegacyTarget) { await target.grounded.revalidate(); }
  async armEffect(target: LegacyTarget, request: PraxisRequest) { target.armed = armExpectedEffect(this.page, request.expectedEffect, request.policy.actionTimeoutMs); }
  async dispatch(target: LegacyTarget, request: PraxisRequest) {
    const options = { timeout: request.policy.actionTimeoutMs };
    const locator = target.grounded.locator;
    switch (request.operation.type) {
      case "activate": await locator.click(target.grounded.adapter === "canvas_coordinate" && target.grounded.actionPoint ? { ...options, position: target.grounded.actionPoint } : options); break;
      case "enter_text": { const value = await this.resolveInput(request.operation.input.reference, request.operation.input.classification); if (target.grounded.adapter === "native_fill") await locator.fill(value, options); else { await locator.focus(options); if (target.grounded.adapter === "content_editable") await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A", options); await this.page.keyboard.insertText(value); } break; }
      case "select_option": await locator.selectOption(await this.resolveInput(request.operation.input.reference, request.operation.input.classification), options); break;
      case "set_checked": await locator.setChecked(request.operation.checked, options); break;
      case "press_key": await locator.press(request.operation.key, options); break;
      case "wait_for_state": if (["visible","hidden","attached","detached"].includes(request.operation.state)) await locator.waitFor({ state: request.operation.state as "visible"|"hidden"|"attached"|"detached", ...options }); else if (request.operation.state === "enabled" ? !(await locator.isEnabled()) : await locator.isEnabled()) throw new PraxisAdapterError("PRAXIS_LOCAL_STATE_NOT_OBSERVED", { provenance: "application", mutationOutcome: "not_applied" }); break;
      case "scroll": if (request.operation.direction === "into_view") await locator.scrollIntoViewIfNeeded(options); else await locator.evaluate((element, direction) => element.scrollBy({ top: direction === "down" ? element.clientHeight : direction === "up" ? -element.clientHeight : 0, left: direction === "right" ? element.clientWidth : direction === "left" ? -element.clientWidth : 0 }), request.operation.direction); break;
      case "read_value": case "inspect": break;
    }
  }
  async verifyLocal(target: LegacyTarget, request: PraxisRequest): Promise<PraxisVerification["local"]> {
    const locator = target.grounded.locator;
    if (request.operation.type === "enter_text") return (await locator.inputValue().catch(() => locator.textContent().then((value) => value ?? ""))).length ? "passed" : "failed";
    if (request.operation.type === "set_checked") return await locator.isChecked() === request.operation.checked ? "passed" : "failed";
    if (request.operation.type === "select_option") return (await locator.inputValue()).length ? "passed" : "failed";
    return "not_required";
  }
  async verifyEffect(target: LegacyTarget, request: PraxisRequest): Promise<PraxisVerification["effect"]> { if (request.expectedEffect.type === "none") return "not_required"; await verifyExpectedEffect(this.page, request.expectedEffect, target.beforeUrl, request.policy.actionTimeoutMs, target.armed); return "passed"; }
}
