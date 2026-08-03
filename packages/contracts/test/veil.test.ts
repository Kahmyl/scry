import { describe, expect, it } from "vitest";

import {
  veilCapabilityLeaseSchema,
  veilEvidenceManifestSchema,
  veilPolicyPreferencesSchema,
  veilPolicySnapshotSchema,
  veilPreferenceUpdateSchema,
  veilRunObservationSchema,
  veilVideoMaskCheckpointSchema,
  veilVideoSegmentFinalizationSchema,
  veilVideoSegmentPermitSchema,
} from "../src/veil.js";

describe("Veil contracts", () => {
  it("defaults to balanced and rejects unknown preference fields", () => {
    expect(veilPolicyPreferencesSchema.parse({ allowedOrigins: ["https://example.com"] }).profile).toBe("balanced");
    expect(() => veilPolicyPreferencesSchema.parse({ allowedOrigins: ["https://example.com"], bypass: true })).toThrow();
  });

  it("rejects noncanonical origins and malformed digests", () => {
    expect(() => veilPolicyPreferencesSchema.parse({ allowedOrigins: ["https://example.com/"] })).toThrow();
    expect(() => veilPolicySnapshotSchema.parse({ schemaVersion: 1, profile: "balanced", allowedOrigins: ["https://example.com"], controls: {}, leaseTtlMs: 5000, digest: "bad" })).toThrow();
  });

  it("keeps leases opaque and evidence omission intervals ordered", () => {
    expect(() => veilCapabilityLeaseSchema.parse({ schemaVersion: 1, token: "predictable", policyDigest: "a".repeat(64), expiresAt: new Date().toISOString() })).toThrow();
    expect(() => veilEvidenceManifestSchema.parse({ schemaVersion: 1, evidenceId: "e1", channel: "video", classification: "public", disposition: "allow", policyDigest: "a".repeat(64), decisionId: "d1", omissionIntervals: [{ startMs: 2, endMs: 1 }], createdAt: new Date().toISOString() })).toThrow();
  });

  it("validates context-bound video permits and tamper-evident checkpoint finalizations", () => {
    const now = new Date().toISOString();
    expect(veilVideoSegmentPermitSchema.parse({ schemaVersion: 1, token: `veil_video_${"x".repeat(32)}`, segmentId: "segment-1", policyDigest: "a".repeat(64), contextDigest: "b".repeat(64), browserContextId: "context", pageId: "page", frameId: "main", documentEpoch: 2, issuedAt: now, expiresAt: now })).toMatchObject({ segmentId: "segment-1", documentEpoch: 2 });
    expect(veilVideoMaskCheckpointSchema.parse({ schemaVersion: 1, segmentId: "segment-1", sequence: 1, documentEpoch: 2, capturePermitDigest: "c".repeat(64), maskDigest: "d".repeat(64), previousCheckpointDigest: null, checkpointDigest: "e".repeat(64), observedAt: now })).toMatchObject({ sequence: 1, previousCheckpointDigest: null });
    expect(veilVideoSegmentFinalizationSchema.parse({ schemaVersion: 1, segmentId: "segment-1", segmentPermitDigest: "f".repeat(64), policyDigest: "a".repeat(64), contextDigest: "b".repeat(64), documentEpoch: 2, checkpointCount: 1, checkpointChainDigest: "e".repeat(64), finalizedAt: now })).toMatchObject({ checkpointCount: 1 });
    expect(() => veilVideoSegmentFinalizationSchema.parse({ schemaVersion: 1, segmentId: "segment-1", segmentPermitDigest: "bad", policyDigest: "a".repeat(64), contextDigest: "b".repeat(64), documentEpoch: 2, checkpointCount: 0, checkpointChainDigest: "e".repeat(64), finalizedAt: now })).toThrow();
  });

  it("keeps preference writes tightening-shaped and findings free of arbitrary content", () => {
    expect(veilPreferenceUpdateSchema.parse({ profile: "private", reasonCode: "VEIL_USER_REQUESTED_PRIVACY" })).toEqual({ profile: "private", reasonCode: "VEIL_USER_REQUESTED_PRIVACY" });
    expect(() => veilPreferenceUpdateSchema.parse({ controls: { quarantineUnknown: false }, reasonCode: "VEIL_USER_REQUESTED_PRIVACY" })).toThrow();
    expect(() => veilRunObservationSchema.parse({
      schemaVersion: 1, effectiveProfile: "private", policyDigest: "a".repeat(64), status: "sealed", timeline: [], gaps: [],
      findings: [{ code: "VEIL_CAPTURE_REFUSED", severity: "blocking", reasonCode: "CAPTURE_REFUSED", remediation: "Contains protected value: secret" , protectedValue: "secret" }],
    })).toThrow();
  });
});
