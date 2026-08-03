import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore, signVeilEvidenceAdmission } from "../src/index.js";

const key = "test-admission-key-that-is-at-least-32-bytes";

const bytes = new TextEncoder().encode("evidence");
const admission = {
  schemaVersion: 1 as const,
  evidenceId: "artifact-1",
  channel: "trace" as const,
  classification: "public" as const,
  disposition: "allow" as const,
  policyDigest: "a".repeat(64),
  decisionId: "decision-1",
  contentDigest: "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e",
  omissionIntervals: [],
  createdAt: "2026-08-03T00:00:00.000Z",
};

describe("LocalArtifactStore", () => {
  it("stores bytes with stable metadata", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")), key);
    const proof = signVeilEvidenceAdmission(admission, key);
    const result = await store.put("run/trace.zip", bytes, proof);
    expect(result.sizeBytes).toBe(8);
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new TextDecoder().decode(await store.get("run/trace.zip", proof))).toBe("evidence");
    expect(await store.size("run/trace.zip", proof)).toBe(8);
    expect(new TextDecoder().decode(await store.getRange("run/trace.zip", 2, 4, proof))).toBe(
      "iden",
    );
  });

  it("rejects traversal keys", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")), key);
    await expect(
      store.put("../secret", bytes, signVeilEvidenceAdmission(admission, key)),
    ).rejects.toThrow("safe relative");
  });

  it("deletes bytes and verifies they are absent", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")), key);
    await store.put("run/uncertain.bin", bytes, signVeilEvidenceAdmission(admission, key));
    await store.delete("run/uncertain.bin");
    await expect(store.exists("run/uncertain.bin")).resolves.toBe(false);
  });

  it("destroys valid, missing, and tampered bytes idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scry-artifact-"));
    const store = new LocalArtifactStore(root, key);
    const proof = signVeilEvidenceAdmission(admission, key);
    await store.put("run/retained.bin", bytes, proof);
    await expect(store.destroy("run/retained.bin", proof)).resolves.toEqual({
      outcome: "deleted",
      bytesDestroyed: true,
    });
    await expect(store.destroy("run/retained.bin", proof)).resolves.toEqual({
      outcome: "missing",
      bytesDestroyed: true,
    });
    await store.put("run/tampered.bin", bytes, proof);
    await writeFile(path.join(root, "run/tampered.bin"), "unsafe replacement");
    await expect(store.destroy("run/tampered.bin", proof)).resolves.toEqual({
      outcome: "tampered",
      bytesDestroyed: true,
    });
    await expect(store.exists("run/tampered.bin")).resolves.toBe(false);
  });

  it("refuses bytes without a matching immutable admission", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")), key);
    await expect(
      store.put(
        "run/tampered.bin",
        new TextEncoder().encode("tampered"),
        signVeilEvidenceAdmission(admission, key),
      ),
    ).rejects.toMatchObject({ code: "VEIL_EVIDENCE_DIGEST_MISMATCH" });
    const quarantined = { ...admission, disposition: "quarantine" as const };
    await expect(
      store.put("run/quarantine.bin", bytes, signVeilEvidenceAdmission(quarantined, key)),
    ).rejects.toMatchObject({ code: "VEIL_EVIDENCE_NOT_ADMITTED" });
    await expect(
      store.put("run/forged.bin", bytes, { manifest: admission, token: "forged" }),
    ).rejects.toMatchObject({ code: "VEIL_EVIDENCE_NOT_ADMITTED" });
    const signed = signVeilEvidenceAdmission(admission, key, {
      stage: "pre_capture",
      method: "mask",
    });
    await expect(
      store.put("run/tampered-attestation.bin", bytes, {
        ...signed,
        sanitation: { stage: "post_capture", method: "mask" },
      }),
    ).rejects.toMatchObject({ code: "VEIL_EVIDENCE_NOT_ADMITTED" });
  });
});
