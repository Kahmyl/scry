import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileVeilPolicy } from "@scry/policy";
import { VEIL_CONTRACT_VERSION, type VeilCapturePermit } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { availableArtifact, registerVeilEvidenceAdmission } from "../src/artifacts.js";
import { VeilAuthority } from "../src/veil-authority.js";

const key = "test-admission-key-that-is-at-least-32-bytes";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scry-veil-artifact-"));
  const file = path.join(root, "capture.png");
  await writeFile(file, "safe-pixels");
  const authority = new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] }));
  const permit: VeilCapturePermit = { schemaVersion: VEIL_CONTRACT_VERSION, token: `veil_capture_${"a".repeat(43)}`, policyDigest: "a".repeat(64), contextDigest: "b".repeat(64), browserContextId: "context", pageId: "page", frameId: "main", documentEpoch: 1, maskDigest: "c".repeat(64), regionCount: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_000).toISOString() };
  const unregister = registerVeilEvidenceAdmission({
    root, authority, admissionKey: key,
    visualAdmission: (candidate) => {
      if (candidate.token !== permit.token) throw new Error("VEIL_CAPTURE_PERMIT_INVALID");
      return { capturePermitDigest: "d".repeat(64), maskDigest: candidate.maskDigest, documentEpoch: candidate.documentEpoch };
    },
    context: () => ({ userId: "user", environmentId: "env", transactionId: "tx", origin: "https://example.test", browserContextId: "context", pageId: "page", frameId: "main", documentEpoch: 1 }),
  });
  return { file, permit, unregister };
}

describe("Veil artifact admission", () => {
  it("requires explicit classification and pre-capture visual sanitation", async () => {
    const { file, unregister } = await fixture();
    try {
      await expect(availableArtifact("screenshot", "image/png", file)).rejects.toThrow("VEIL_EVIDENCE_CLASSIFICATION_REQUIRED");
      await expect(availableArtifact("screenshot", "image/png", file, undefined, { classification: "unknown" })).rejects.toThrow("VEIL_EVIDENCE_CLASSIFICATION_REFUSED");
      await expect(availableArtifact("screenshot", "image/png", file, undefined, { classification: "public" })).rejects.toThrow("VEIL_CAPTURE_PERMIT_BINDING_REQUIRED");
      await expect(availableArtifact("screenshot", "image/png", file, undefined, {
        classification: "public", sanitation: { stage: "post_capture", method: "SecretRedactor.redact", attestedAt: new Date().toISOString() },
      })).rejects.toThrow("VEIL_CAPTURE_PERMIT_BINDING_REQUIRED");
    } finally { unregister(); }
  });

  it("admits bytes only with the recognized pre-capture visual attestation", async () => {
    const { file, permit, unregister } = await fixture();
    try {
      const artifact = await availableArtifact("screenshot", "image/png", file, undefined, {
        classification: "public", capturePermit: permit,
      });
      expect(artifact.availability).toBe("available");
      expect(artifact.observation).toMatchObject({ veilManifest: { classification: "public" }, veilSanitation: { stage: "pre_capture" } });
      expect(artifact.observation?.veilAdmissionToken).toEqual(expect.any(String));
    } finally { unregister(); }
  });
});
