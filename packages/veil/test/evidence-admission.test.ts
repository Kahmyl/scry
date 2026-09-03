import { describe, expect, it } from "vitest";

import {
  compileVeilPolicy,
  finalizeVeilArtifactEvidence,
  prepareVeilArtifactEvidence,
  registerVeilEvidenceAdmission,
  VeilAuthority,
} from "../src/index.js";

const root = "/tmp/scry-evidence-admission";

function registration() {
  const authority = new VeilAuthority(
    compileVeilPolicy({
      profile: "balanced",
      allowedOrigins: ["https://example.test"],
    }),
  );

  return registerVeilEvidenceAdmission({
    root,
    authority,
    admissionKey: "test-admission-key-that-is-at-least-32-bytes",
    context: () => ({
      userId: "user",
      environmentId: "env",
      transactionId: "tx",
      origin: "https://example.test",
      browserContextId: "context",
      pageId: "page",
      frameId: "main",
      documentEpoch: 1,
    }),
  });
}

describe("Veil evidence admission", () => {
  it("refuses unknown evidence before byte materialization", () => {
    const unregister = registration();

    try {
      expect(() =>
        prepareVeilArtifactEvidence({
          kind: "report",
          filePath: `${root}/does-not-exist.json`,
          evidence: {
            classification: "unknown",
          },
        }),
      ).toThrow("VEIL_EVIDENCE_CLASSIFICATION_REFUSED");
    } finally {
      unregister();
    }
  });

  it("produces authorization facts before Chronicle binds identity and digest", () => {
    const unregister = registration();

    try {
      const prepared = prepareVeilArtifactEvidence({
        kind: "report",
        filePath: `${root}/report.json`,
        evidence: {
          classification: "public",
        },
      });

      const finalized = finalizeVeilArtifactEvidence(prepared, {
        evidenceId: "evidence",
        contentDigest: "b".repeat(64),
      });

      expect(finalized.manifest).toMatchObject({
        evidenceId: "evidence",
        classification: "public",
        contentDigest: "b".repeat(64),
      });

      expect(finalized.sanitation).toMatchObject({
        stage: "not_required",
        method: "classified_public_at_source",
      });
    } finally {
      unregister();
    }
  });
});
