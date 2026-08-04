import { describe, expect, it } from "vitest";

import { compileVeilPolicy } from "../src/policy.js";
import type { VeilLeaseRequest } from "@scry/contracts";
import { createDefaultVeilContext, VeilAuthority, VeilAuthorityError } from "../src/authority.js";

const request: VeilLeaseRequest = {
  context: {
    userId: "u1",
    environmentId: "env",
    transactionId: "tx",
    origin: "https://example.com",
    browserContextId: "browser",
    pageId: "page",
    frameId: "frame",
    documentEpoch: 1,
  },
  operation: "capture",
  channel: "screenshot",
  classification: "public",
  scope: "channel",
};

describe("VeilAuthority", () => {
  it("creates a stable local context adapter for existing callers", () => {
    expect(
      createDefaultVeilContext({
        transactionId: "tx",
        origin: "https://example.com",
        browserContextId: "browser",
        pageId: "page",
        frameId: "frame",
        documentEpoch: 0,
      }),
    ).toMatchObject({ userId: "local-user", environmentId: "local-environment" });
  });
  it("issues opaque leases and validates their exact binding", () => {
    const authority = new VeilAuthority(
      compileVeilPolicy({ allowedOrigins: ["https://example.com"] }),
    );
    const { decision, lease } = authority.issueLease(request);
    expect(decision.disposition).toBe("allow");
    expect(lease.token).toMatch(/^veil_[A-Za-z0-9_-]{32,}$/);
    expect(lease.token).not.toBe(request.context.transactionId);
    expect(authority.validateLease(lease, request).disposition).toBe("allow");
    expect(() =>
      authority.validateLease(lease, {
        ...request,
        context: { ...request.context, documentEpoch: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: "VEIL_LEASE_CONTEXT_MISMATCH" }));
  });

  it("rejects forged and expired leases", () => {
    let now = 1_000;
    const authority = new VeilAuthority(
      compileVeilPolicy({ allowedOrigins: ["https://example.com"], leaseTtlMs: 100 }),
      () => now,
    );
    const { lease } = authority.issueLease(request);
    expect(() => authority.validateLease({ ...lease, token: `${lease.token}x` }, request)).toThrow(
      VeilAuthorityError,
    );
    now = 1_100;
    expect(() => authority.validateLease(lease, request)).toThrowError(
      expect.objectContaining({ code: "VEIL_LEASE_EXPIRED" }),
    );
  });

  it("invalidates leases on policy and document context changes", () => {
    const authority = new VeilAuthority(
      compileVeilPolicy({ allowedOrigins: ["https://example.com"] }),
    );
    const first = authority.issueLease(request).lease;
    authority.updatePolicy(
      compileVeilPolicy({ profile: "private", allowedOrigins: ["https://example.com"] }),
    );
    expect(() => authority.validateLease(first, request)).toThrowError(
      expect.objectContaining({ code: "VEIL_LEASE_INVALID" }),
    );
    const second = authority.issueLease(request).lease;
    expect(authority.invalidateContext({ pageId: "page", documentEpoch: 1 })).toBe(1);
    expect(() => authority.validateLease(second, request)).toThrowError(
      expect.objectContaining({ code: "VEIL_LEASE_INVALID" }),
    );
  });

  it("caches only exact decisions and clears the cache on policy change", () => {
    const authority = new VeilAuthority(
      compileVeilPolicy({ allowedOrigins: ["https://example.com"] }),
    );
    authority.decide(request);
    authority.decide(request);
    expect(authority.cacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    authority.decide({ ...request, context: { ...request.context, documentEpoch: 2 } });
    expect(authority.cacheStats()).toMatchObject({ hits: 1, misses: 2, entries: 2 });
    const next = compileVeilPolicy({ profile: "private", allowedOrigins: ["https://example.com"] });
    authority.updatePolicy(next);
    expect(authority.cacheStats()).toMatchObject({ entries: 0, policyDigest: next.digest });
  });

  it("refuses secrets, unknown classifications, disabled channels, and forbidden origins", () => {
    const authority = new VeilAuthority(
      compileVeilPolicy({ profile: "private", allowedOrigins: ["https://example.com"] }),
    );
    for (const update of [
      { classification: "secret" },
      { classification: "unknown" },
      { channel: "video" },
    ] as const) {
      expect(() => authority.issueLease({ ...request, ...update })).toThrowError(
        expect.objectContaining({ code: "VEIL_CAPABILITY_REFUSED" }),
      );
    }
    expect(() =>
      authority.issueLease({
        ...request,
        context: { ...request.context, origin: "https://other.example" },
      }),
    ).toThrowError(expect.objectContaining({ code: "VEIL_ORIGIN_FORBIDDEN" }));
  });
});
