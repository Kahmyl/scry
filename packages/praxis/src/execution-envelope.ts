import type { EvidenceFamily, PraxisRequest } from "@scry/contracts";
import type { Page } from "playwright";

export class PraxisAdmissionError extends Error {
  constructor(readonly code: "PRAXIS_ORIGIN_NOT_ALLOWED" | "PRAXIS_REQUIRED_CHANNEL_FORBIDDEN") {
    super(code);
    this.name = "PraxisAdmissionError";
  }
}

const familyChannels: Partial<Record<EvidenceFamily, readonly string[]>> = {
  native_control: ["public_dom"],
  accessibility: ["accessibility"],
  textual: ["public_dom"],
  structural: ["public_dom"],
  visual: ["visual"],
  historical: ["public_dom"],
  runtime: ["public_dom"],
  effect: ["public_dom"],
};

export class PraxisExecutionEnvelope {
  static admit(page: Page, request: PraxisRequest) {
    const permitted = new Set(request.policy.allowedOrigins.map(origin));
    const pageUrl = page.url();
    const networkDocument = /^https?:/i.test(pageUrl);
    const declared = /^https?:/i.test(request.context.origin)
      ? request.context.origin
      : request.policy.allowedOrigins[0]!;
    const actualOrigin = origin(networkDocument ? pageUrl : declared);
    if (!permitted.has(actualOrigin)) throw new PraxisAdmissionError("PRAXIS_ORIGIN_NOT_ALLOWED");

    const allowed = new Set(request.privacy.allowedChannels);
    const suppressed = new Set(request.privacy.suppressedChannels);
    const required = new Set<string>();
    for (const family of request.intent.confidence.requiredFamilies)
      for (const channel of familyChannels[family] ?? []) required.add(channel);
    for (const source of request.intent.preferredEvidence.visual?.sources ?? [])
      required.add(source === "ocr" ? "ocr" : "visual");
    for (const channel of required)
      if (!allowed.has(channel) || suppressed.has(channel)) {
        throw new PraxisAdmissionError("PRAXIS_REQUIRED_CHANNEL_FORBIDDEN");
      }
  }

  static groundingWindow(request: PraxisRequest) {
    return Math.min(500, Math.max(100, Math.floor(request.policy.totalTimeoutMs * 0.35)));
  }
  static remaining(deadline: number) {
    return Math.max(0, deadline - performance.now());
  }
  static verificationBudget(deadline: number, actionTimeoutMs: number) {
    return Math.max(1, Math.min(actionTimeoutMs, PraxisExecutionEnvelope.remaining(deadline) - 25));
  }
}

function origin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "https://invalid.praxis";
  }
}
