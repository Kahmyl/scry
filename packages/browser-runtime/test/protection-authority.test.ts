import { describe, expect, it } from "vitest";
import {
  ProtectionAuthority,
  protectionSinks,
  type AdmittedFieldEvidence,
  type ProtectionCandidate,
} from "../src/index.js";

const scope = {
  projectId: "project-1",
  missionId: "mission-1",
  runId: "run-1",
  sessionId: "session-1",
  origin: "https://fixture.example",
};
function evidence(
  semantic: string,
  path: readonly (string | number)[],
  sourceDigest: string,
  revision = 1,
): AdmittedFieldEvidence {
  return {
    semantic,
    path,
    source: "environment_disclosure_policy",
    sourceDigest,
    captureId: "capture-stale",
    captureDigest: "c".repeat(64),
    contentClass: "http_json",
    admissionMode: "trusted_application_output",
    origin: scope.origin,
    observedAt: "2026-09-02T10:00:00.000Z",
    revision,
  };
}

const capture = (id: string) => ({
  id,
  digest: "c".repeat(64),
  observedAt: "2026-09-02T10:00:00.000Z",
  contentClass: "http_json" as const,
});

function trustedAuthority() {
  return new ProtectionAuthority({ scope, disclosureMode: "trusted_application_output" });
}

describe("single protection authority", () => {
  it("quarantines every sink before settlement and protects a short semantic secret", () => {
    const authority = new ProtectionAuthority({ scope });
    const token = authority.begin("effect-1");
    expect(authority.sanitize("visible page violet7")).toBe("[QUARANTINED]");
    const candidates: ProtectionCandidate[] = [
      { path: ["activationCode"], value: "violet7", semanticHint: "activation secret" },
    ];
    const [decision] = authority.settle({
      token,
      captureId: "capture-1",
      candidates,
      proposals: [
        { key: "activation_code", path: ["activationCode"], classification: "protected" },
      ],
    });
    expect(decision?.label).toBe("protected");
    for (const sink of protectionSinks)
      expect(authority.emit("violet7", decision!, sink)).toBe("[PROTECTED]");
    expect(authority.sanitize("value=violet7")).not.toContain("violet7");
  });

  it("releases an ordinary public identifier only with exact environment evidence", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-2");
    const admitted = authority.publicEvidence(
      token,
      "resource_identity",
      ["resourceKey"],
      capture("capture-2"),
    );
    const [decision] = authority.settle({
      token,
      captureId: "capture-2",
      candidates: [{ path: ["resourceKey"], value: "resource-public-123456" }],
      proposals: [
        {
          key: "resource_identity",
          semantic: "resource_identity",
          path: ["resourceKey"],
          classification: "public",
          evidence: admitted,
        },
      ],
    });
    expect(authority.emit("resource-public-123456", decision!, "report")).toBe(
      "resource-public-123456",
    );
    expect(authority.sanitize("id=resource-public-123456", "report")).toContain(
      "resource-public-123456",
    );
    expect(authority.sanitize("id=resource-public-123456", "recording")).toContain(
      "resource-public-123456",
    );
  });

  it("does not let a release grant declassify a semantically protected value", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-sensitive-grant");
    expect(() =>
      authority.settle({
        token,
        captureId: "capture-sensitive-grant",
        candidates: [
          {
            path: ["data", "clientSecret"],
            value: "brief-value",
            semanticHint: "client secret",
          },
        ],
        proposals: [
          {
            key: "clientSecret",
            semantic: "clientSecret",
            path: ["data", "clientSecret"],
            classification: "public",
            evidence: authority.publicEvidence(
              token,
              "clientSecret",
              ["data", "clientSecret"],
              capture("capture-sensitive-grant"),
            ),
          },
        ],
      }),
    ).toThrow("protection_declassification_forbidden");
  });

  it("does not let an ordinary semantic declassify a high-confidence secret pattern", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-pattern-veto");
    expect(() =>
      authority.settle({
        token,
        captureId: "capture-pattern-veto",
        candidates: [{ path: ["result", "value"], value: "sk_live_abcdefghijklmnop" }],
        proposals: [
          {
            key: "resourceId",
            semantic: "resourceId",
            path: ["result", "value"],
            classification: "public",
            evidence: authority.publicEvidence(
              token,
              "resourceId",
              ["result", "value"],
              capture("capture-pattern-veto"),
            ),
          },
        ],
      }),
    ).toThrow("protection_declassification_forbidden");
  });

  it("uses one scoped ordinary-data authorization without requiring a field-name whitelist", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-scoped-public");
    const admitted = authority.publicEvidence(
      token,
      "stockSku",
      ["record", "sku"],
      capture("capture-scoped-public"),
    );
    const [decision] = authority.settle({
      token,
      captureId: "capture-scoped-public",
      candidates: [{ path: ["record", "sku"], value: "SKU-310905" }],
      proposals: [
        {
          key: "stockSku",
          semantic: "stockSku",
          path: ["record", "sku"],
          classification: "public",
          evidence: admitted,
        },
      ],
    });
    expect(decision).toMatchObject({ label: "public", publicSemantic: "stockSku" });
  });

  it("recognizes a documented uuid field as ordinary identity context", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-scoped-uuid");
    const path = ["envelope", "candidates", 1, "uuid"] as const;
    const admitted = authority.publicEvidence(
      token,
      "resourceId",
      [...path],
      capture("capture-scoped-uuid"),
    );
    const [decision] = authority.settle({
      token,
      captureId: "capture-scoped-uuid",
      candidates: [{ path: [...path], value: "resource-identity-123" }],
      proposals: [
        {
          key: "resourceId",
          semantic: "resourceId",
          path: [...path],
          classification: "public",
          evidence: admitted,
        },
      ],
    });
    expect(decision).toMatchObject({ label: "public", publicSemantic: "resourceId" });
  });

  it("allows a specifically named ordinary boolean without a field whitelist", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-scoped-ok");
    const admitted = authority.publicEvidence(
      token,
      "requestAccepted",
      ["ok"],
      capture("capture-scoped-ok"),
    );
    const [decision] = authority.settle({
      token,
      captureId: "capture-scoped-ok",
      candidates: [{ path: ["ok"], value: true }],
      proposals: [
        {
          key: "requestAccepted",
          semantic: "requestAccepted",
          path: ["ok"],
          classification: "public",
          evidence: admitted,
        },
      ],
    });
    expect(decision).toMatchObject({ label: "public", publicSemantic: "requestAccepted" });
  });

  it("does not turn an omitted ordinary scalar into protected lineage", () => {
    const authority = new ProtectionAuthority({ scope });
    const token = authority.begin("effect-ordinary-omitted");
    expect(
      authority.settle({
        token,
        captureId: "capture-ordinary-omitted",
        candidates: [
          { path: ["record", "sku"], value: "SKU-310905" },
          { path: ["record", "client_secret"], value: "brief7" },
        ],
        proposals: [],
      }),
    ).toHaveLength(1);
    expect(authority.sanitize("Retrieved SKU-310905")).toContain("SKU-310905");
    expect(authority.sanitize("secret brief7")).not.toContain("brief7");
  });

  it("makes the trusted-application tradeoff explicit for an otherwise ordinary generic value", () => {
    const authority = trustedAuthority();
    const token = authority.begin("effect-scoped-secret");
    const [decision] = authority.settle({
        token,
        captureId: "capture-scoped-secret",
        candidates: [{ path: ["result", "value"], value: "brief7" }],
        proposals: [
          {
            key: "resourceId",
            semantic: "resourceId",
            path: ["result", "value"],
            classification: "public",
            evidence: authority.publicEvidence(
              token,
              "resourceId",
              ["result", "value"],
              capture("capture-scoped-secret"),
            ),
          },
        ],
      });
    expect(decision).toMatchObject({
      label: "public",
      publicAdmissionMode: "trusted_application_output",
    });
  });

  it("restores an admitted public identifier with its exact sink permissions", () => {
    const replacement = new ProtectionAuthority({
      scope,
      restoredPublicValues: [
        {
          value: "sk_live_public_resource_123456",
          allowedSinks: ["agent_observation", "report"],
        },
      ],
    });
    expect(replacement.sanitize("id=sk_live_public_resource_123456", "report")).toContain(
      "sk_live_public_resource_123456",
    );
    expect(replacement.sanitize("id=sk_live_public_resource_123456", "recording")).not.toContain(
      "sk_live_public_resource_123456",
    );
  });

  it("gives exact protected lineage precedence over public exceptions and substrings", () => {
    const authority = new ProtectionAuthority({
      scope,
      protectedValues: {
        exact: "sk_live_same_value_123456",
        containing: "sk_live_public_piece_123456_private_tail",
      },
      restoredPublicValues: [
        { value: "sk_live_same_value_123456", allowedSinks: ["report"] },
        { value: "sk_live_public_piece_123456", allowedSinks: ["report"] },
      ],
    });
    expect(authority.sanitize("sk_live_same_value_123456", "report")).not.toContain(
      "sk_live_same_value_123456",
    );
    expect(authority.sanitize("sk_live_public_piece_123456_private_tail", "report")).not.toContain(
      "sk_live_public_piece_123456_private_tail",
    );
    expect(authority.sanitize("sk_live_public_piece_123456", "report")).toContain(
      "sk_live_public_piece_123456",
    );
  });

  it("sanitizes protected object keys as well as values", () => {
    const authority = new ProtectionAuthority({
      scope,
      protectedValues: { secret: "tiny7" },
    });
    const sanitized = authority.sanitizeValue({ "field-tiny7": "value-tiny7" }, "", "report");
    expect(JSON.stringify(sanitized)).not.toContain("tiny7");
    const token = authority.begin("effect-quarantine-keys");
    expect(authority.sanitizeValue({ type: 2, data: "unknown" }, "", "recording")).toEqual({
      type: 2,
      data: "[QUARANTINED]",
    });
    authority.abort(token);
  });

  it("rejects missing, stale, conflicting, and protected-lineage declassification", () => {
    const make = () =>
      new ProtectionAuthority({
        scope,
        disclosureMode: "trusted_application_output",
      });
    const missing = make();
    expect(() =>
      missing.settle({
        token: missing.begin("effect-missing"),
        captureId: "capture-missing",
        candidates: [{ path: ["id"], value: "id-1" }],
        proposals: [
          {
            key: "resource_identity",
            semantic: "resource_identity",
            path: ["id"],
            classification: "public",
          },
        ],
      }),
    ).toThrow("protection_public_evidence_missing");

    const stale = make();
    expect(() =>
      stale.settle({
        token: stale.begin("effect-stale"),
        captureId: "capture-stale",
        candidates: [{ path: ["id"], value: "id-1" }],
        proposals: [
          {
            key: "resource_identity",
            semantic: "resource_identity",
            path: ["id"],
            classification: "public",
            evidence: evidence(
              "resource_identity",
              ["id"],
              "0".repeat(64),
              99,
            ),
          },
        ],
      }),
    ).toThrow("protection_public_evidence_mismatch");

    const lineage = make();
    expect(() =>
      lineage.settle({
        token: lineage.begin("effect-lineage"),
        captureId: "capture-lineage",
        candidates: [{ path: ["id"], value: "id-1", protectedLineage: true }],
        proposals: [
          {
            key: "resource_identity",
            semantic: "resource_identity",
            path: ["id"],
            classification: "public",
            evidence: evidence(
              "resource_identity",
              ["id"],
              "0".repeat(64),
            ),
          },
        ],
      }),
    ).toThrow("protection_declassification_forbidden");
  });

  it("settles idempotently and rejects a changed replay", () => {
    const authority = new ProtectionAuthority({ scope });
    const token = authority.begin("effect-3");
    const input = {
      token,
      captureId: "capture-3",
      candidates: [{ path: ["secret"], value: "short7" }],
      proposals: [{ key: "secret", path: ["secret"], classification: "protected" as const }],
    };
    const first = authority.settle(input);
    expect(authority.settle(input)).toEqual(first);
    expect(() =>
      authority.settle({
        ...input,
        candidates: [{ path: ["secret"], value: "changed" }],
      }),
    ).toThrow("protection_settlement_conflict");
  });

  it("does not let a protected structural boolean poison a later public boolean", () => {
    const authority = trustedAuthority();
    authority.settle({
      token: authority.begin("effect-dom"),
      captureId: "capture-dom",
      candidates: [{ path: ["visible"], value: true }],
      proposals: [],
    });
    const token = authority.begin("effect-order");
    const [decision] = authority.settle({
      token,
      captureId: "capture-order",
      candidates: [{ path: ["data", "completed"], value: true }],
      proposals: [
        {
          key: "completed",
          semantic: "completed",
          path: ["data", "completed"],
          classification: "public",
          evidence: authority.publicEvidence(
            token,
            "completed",
            ["data", "completed"],
            capture("capture-order"),
          ),
        },
      ],
    });
    expect(authority.emit(true, decision!, "mcp_response")).toBe(true);
  });

  it("resumes an unsettled durable barrier after worker replacement", () => {
    const first = new ProtectionAuthority({ scope });
    const token = first.begin("effect-restart");
    const replacement = new ProtectionAuthority({ scope });
    replacement.resume(token);
    const [decision] = replacement.settle({
      token,
      captureId: "capture-restart",
      candidates: [{ path: ["secret"], value: "tiny7" }],
      proposals: [{ key: "secret", path: ["secret"], classification: "protected" }],
    });
    expect(decision?.label).toBe("protected");
  });
});
