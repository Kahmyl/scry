import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import type { PraxisRequest, VeilLeaseRequest } from "@scry/contracts";
import { compileVeilPolicy } from "@scry/veil";
import { VeilAuthority } from "@scry/veil";
import {
  authorizePraxisRequest,
  PraxisVeilAuthorizationError,
  registerPraxisVeilAuthority,
  releasePraxisVeilGrants,
  validatePraxisVeilBoundary,
  validatePraxisVeilGrants,
} from "../src/veil-bridge.js";

function request(): PraxisRequest {
  return {
    schemaVersion: 1,
    transactionId: "tx-veil-boundaries",
    operationId: "activate-1",
    intent: {
      concept: "Save",
      requiredCapabilities: ["pointer_activatable"],
      preferredEvidence: {
        roles: ["button"],
        names: ["Save"],
        labels: [],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: [],
      risk: "protected",
      confidence: { requiredFamilies: [], minimum: 0.5, minimumMargin: 0, minimumFamilyCount: 1 },
    },
    operation: { type: "activate" },
    expectedEffect: { type: "none" },
    risk: "protected",
    policy: {
      allowedOrigins: ["https://example.test"],
      actionTimeoutMs: 1_000,
      totalTimeoutMs: 2_000,
    },
    privacy: {
      state: "normal",
      allowedChannels: ["public_dom", "accessibility", "unsupported"],
      suppressedChannels: [],
    },
    context: { pageId: "page-1", origin: "https://example.test", documentEpoch: 3 },
  };
}

function setup(now: () => number = Date.now) {
  const page = {} as Page;
  const authority = new VeilAuthority(
    compileVeilPolicy({
      profile: "balanced",
      allowedOrigins: ["https://example.test"],
      leaseTtlMs: 100,
    }),
    now,
  );
  registerPraxisVeilAuthority(page, {
    authority,
    userId: "user-1",
    environmentId: "test",
    browserContextId: "context-1",
  });
  return { page, authority };
}

describe("Praxis Veil capability boundaries", () => {
  it("restores the outer authority after a nested registration is released", () => {
    const page = {} as Page;
    const outer = new VeilAuthority(
      compileVeilPolicy({
        profile: "balanced",
        allowedOrigins: ["https://example.test"],
        leaseTtlMs: 100,
      }),
    );
    const inner = new VeilAuthority(
      compileVeilPolicy({
        profile: "balanced",
        allowedOrigins: ["https://example.test"],
        leaseTtlMs: 100,
      }),
    );
    const outerIssue = vi.spyOn(outer, "issueLease");
    const innerIssue = vi.spyOn(inner, "issueLease");
    const unregisterOuter = registerPraxisVeilAuthority(page, {
      authority: outer,
      userId: "outer-user",
      environmentId: "test",
      browserContextId: "outer-context",
    });
    const unregisterInner = registerPraxisVeilAuthority(page, {
      authority: inner,
      userId: "inner-user",
      environmentId: "test",
      browserContextId: "inner-context",
    });

    releasePraxisVeilGrants(authorizePraxisRequest(page, request()));
    expect(innerIssue).toHaveBeenCalled();
    expect(outerIssue).not.toHaveBeenCalled();

    unregisterInner();
    releasePraxisVeilGrants(authorizePraxisRequest(page, request()));
    expect(outerIssue).toHaveBeenCalled();

    unregisterOuter();
    expect(() => authorizePraxisRequest(page, request())).toThrowError(
      expect.objectContaining({ code: "PRAXIS_VEIL_OBSERVE_REFUSED" }),
    );
  });

  it("does not let out-of-order cleanup remove the active nested authority", () => {
    const page = {} as Page;
    const outer = setupAuthority();
    const inner = setupAuthority();
    const unregisterOuter = registerPraxisVeilAuthority(page, registration(outer, "outer"));
    const unregisterInner = registerPraxisVeilAuthority(page, registration(inner, "inner"));

    unregisterOuter();
    const authorized = authorizePraxisRequest(page, request());
    expect(() => validatePraxisVeilGrants(authorized)).not.toThrow();
    releasePraxisVeilGrants(authorized);

    unregisterInner();
    expect(() => authorizePraxisRequest(page, request())).toThrowError(
      expect.objectContaining({ code: "PRAXIS_VEIL_OBSERVE_REFUSED" }),
    );
  });

  it("binds observation, protected transaction, evidence, and admission leases exactly", () => {
    const { page, authority } = setup();
    const issued: VeilLeaseRequest[] = [];
    const original = authority.issueLease.bind(authority);
    vi.spyOn(authority, "issueLease").mockImplementation((value) => {
      issued.push(value);
      return original(value);
    });
    const authorized = authorizePraxisRequest(page, request());
    expect(authorized.privacy).toMatchObject({
      allowedChannels: ["public_dom", "accessibility"],
      suppressedChannels: ["unsupported"],
    });
    validatePraxisVeilGrants(authorized);
    validatePraxisVeilBoundary(authorized, "protected_transaction");
    validatePraxisVeilBoundary(authorized, "produce_evidence");
    validatePraxisVeilBoundary(authorized, "admit_result");
    expect(issued.map(({ operation, channel }) => `${operation}:${channel}`)).toEqual([
      "observe:dom",
      "observe:accessibility",
      "protected_transaction:event",
      "capture:report",
      "admit_evidence:report",
    ]);
    expect(
      issued.every(
        ({ context }) =>
          context.transactionId === authorized.transactionId &&
          context.documentEpoch === 3 &&
          context.browserContextId === "context-1",
      ),
    ).toBe(true);
  });

  it("releases every issued lease idempotently", () => {
    const { page, authority } = setup();
    const revoke = vi.spyOn(authority, "revoke");
    const authorized = authorizePraxisRequest(page, request());
    validatePraxisVeilBoundary(authorized, "protected_transaction");
    validatePraxisVeilBoundary(authorized, "produce_evidence");
    releasePraxisVeilGrants(authorized);
    releasePraxisVeilGrants(authorized);
    expect(revoke).toHaveBeenCalledTimes(4); // two observation + protected transaction + evidence
    expect(() => validatePraxisVeilBoundary(authorized, "protected_transaction")).toThrow(
      PraxisVeilAuthorizationError,
    );
  });

  it("returns a typed refusal when a short-lived capability expires", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { page } = setup(() => now);
    const authorized = authorizePraxisRequest(page, request());
    now += 101;
    expect(() => validatePraxisVeilBoundary(authorized, "observe")).toThrowError(
      expect.objectContaining({ code: "PRAXIS_VEIL_OBSERVE_REFUSED", boundary: "observe" }),
    );
    releasePraxisVeilGrants(authorized);
  });

  it("rejects mutation of an authorized request instead of reusing its leases", () => {
    const { page } = setup();
    const authorized = authorizePraxisRequest(page, request());
    authorized.context.documentEpoch = 4;
    expect(() => validatePraxisVeilBoundary(authorized, "protected_transaction")).toThrowError(
      expect.objectContaining({ code: "PRAXIS_VEIL_PROTECTED_TRANSACTION_REFUSED" }),
    );
    releasePraxisVeilGrants(authorized);
  });
});

function setupAuthority() {
  return new VeilAuthority(
    compileVeilPolicy({
      profile: "balanced",
      allowedOrigins: ["https://example.test"],
      leaseTtlMs: 100,
    }),
  );
}

function registration(authority: VeilAuthority, suffix: string) {
  return {
    authority,
    userId: `${suffix}-user`,
    environmentId: "test",
    browserContextId: `${suffix}-context`,
  };
}
