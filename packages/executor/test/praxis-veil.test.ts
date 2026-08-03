import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import type { PraxisRequest, VeilLeaseRequest } from "@scry/contracts";
import { compileVeilPolicy } from "@scry/policy";
import { VeilAuthority } from "../src/veil-authority.js";
import {
  authorizePraxisRequest, PraxisVeilAuthorizationError, registerPraxisVeilAuthority,
  releasePraxisVeilGrants, validatePraxisVeilBoundary, validatePraxisVeilGrants,
} from "../src/praxis-veil.js";

function request(): PraxisRequest {
  return {
    schemaVersion: 1, transactionId: "tx-veil-boundaries", operationId: "activate-1",
    intent: { concept: "Save", requiredCapabilities: ["pointer_activatable"], preferredEvidence: { roles: ["button"], names: ["Save"], labels: [], descriptions: [], placeholders: [], inputTypes: [] }, scope: { kind: "page" }, relations: [], prohibited: [], risk: "protected", confidence: { requiredFamilies: [], minimum: .5, minimumMargin: 0, minimumFamilyCount: 1 } },
    operation: { type: "activate" }, expectedEffect: { type: "none" }, risk: "protected",
    policy: { allowedOrigins: ["https://example.test"], actionTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
    privacy: { state: "normal", allowedChannels: ["public_dom", "accessibility", "unsupported"], suppressedChannels: [] },
    context: { pageId: "page-1", origin: "https://example.test", documentEpoch: 3 },
  };
}

function setup(now: () => number = Date.now) {
  const page = {} as Page;
  const authority = new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"], leaseTtlMs: 100 }), now);
  registerPraxisVeilAuthority(page, { authority, userId: "user-1", environmentId: "test", browserContextId: "context-1" });
  return { page, authority };
}

describe("Praxis Veil capability boundaries", () => {
  it("binds scheduling, observation, interaction, protected transaction, evidence, and admission leases exactly", () => {
    const { page, authority } = setup();
    const issued: VeilLeaseRequest[] = [];
    const original = authority.issueLease.bind(authority);
    vi.spyOn(authority, "issueLease").mockImplementation((value) => { issued.push(value); return original(value); });
    const authorized = authorizePraxisRequest(page, request());
    expect(authorized.privacy).toMatchObject({ allowedChannels: ["public_dom", "accessibility"], suppressedChannels: ["unsupported"] });
    validatePraxisVeilGrants(authorized);
    validatePraxisVeilBoundary(authorized, "interact");
    validatePraxisVeilBoundary(authorized, "protected_transaction");
    validatePraxisVeilBoundary(authorized, "produce_evidence");
    validatePraxisVeilBoundary(authorized, "admit_result");
    expect(issued.map(({ operation, channel }) => `${operation}:${channel}`)).toEqual([
      "schedule:metadata", "observe:dom", "observe:accessibility", "interact:event",
      "protected_transaction:event", "capture:report", "admit_evidence:report",
    ]);
    expect(issued.every(({ context }) => context.transactionId === authorized.transactionId && context.documentEpoch === 3 && context.browserContextId === "context-1")).toBe(true);
  });

  it("releases every issued lease idempotently", () => {
    const { page, authority } = setup();
    const revoke = vi.spyOn(authority, "revoke");
    const authorized = authorizePraxisRequest(page, request());
    validatePraxisVeilBoundary(authorized, "interact");
    validatePraxisVeilBoundary(authorized, "produce_evidence");
    releasePraxisVeilGrants(authorized);
    releasePraxisVeilGrants(authorized);
    expect(revoke).toHaveBeenCalledTimes(5); // schedule + two observation + interaction + evidence
    expect(() => validatePraxisVeilBoundary(authorized, "schedule")).toThrow(PraxisVeilAuthorizationError);
  });

  it("returns a typed refusal when a short-lived capability expires", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { page } = setup(() => now);
    const authorized = authorizePraxisRequest(page, request());
    now += 101;
    expect(() => validatePraxisVeilBoundary(authorized, "schedule")).toThrowError(expect.objectContaining({ code: "PRAXIS_VEIL_SCHEDULE_REFUSED", boundary: "schedule" }));
    releasePraxisVeilGrants(authorized);
  });

  it("rejects mutation of an authorized request instead of reusing its leases", () => {
    const { page } = setup();
    const authorized = authorizePraxisRequest(page, request());
    authorized.context.documentEpoch = 4;
    expect(() => validatePraxisVeilBoundary(authorized, "interact")).toThrowError(expect.objectContaining({ code: "PRAXIS_VEIL_INTERACT_REFUSED" }));
    releasePraxisVeilGrants(authorized);
  });
});
