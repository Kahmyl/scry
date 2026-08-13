import { describe, expect, it } from "vitest";

import { protectedTransactionSchema } from "../src/current.js";
import { externalResourcePresentationContractSchema } from "../src/grounding.js";
import { updateEnvironmentSchema } from "../src/api.js";

const intent = {
  concept: "target", requiredCapabilities: ["observable"],
  preferredEvidence: { roles: ["text"], names: ["value"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
  scope: { kind: "page" }, relations: [], prohibited: [], risk: "read_only",
  confidence: { requiredFamilies: [] }, matching: "exact",
} as const;

const transaction = {
  type: "protectedTransaction", operationId: "operation",
  entry: { url: "https://example.test", assertions: [{ type: "url", expected: "https://example.test", match: "exact", timeoutMs: 1000 }] },
  inputs: {}, preparation: { actions: [{ type: "navigate", url: "https://example.test", effect: "read_only", timeoutMs: 1000 }], assertions: [{ type: "visible", target: intent, timeoutMs: 1000 }], effectPolicy: { ignoredRequests: [] } },
  mutation: { action: { type: "click", target: { ...intent, requiredCapabilities: ["focusable", "pointer_activatable"], risk: "protected" }, expectedEffect: { type: "none" }, timeoutMs: 1000 }, kind: "one_time", dispatchSemantics: "mutation", reconciliation: { strategy: "persisted_outputs", requiredReferences: ["publicId", "secret"] } },
  extraction: { outputs: [
    { classification: "public", reference: "publicId", acquisition: { target: intent, classification: "public", permittedMethods: ["text_content"], objective: { kind: "capture_value", expectedValueType: "public" }, validation: { minimumLength: 1, maximumLength: 100 } }, storage: { name: "Public ID", scope: "project" } },
    { classification: "protected", reference: "secret", acquisition: { target: intent, classification: "unknown_secret", permittedMethods: ["text_content"], objective: { kind: "capture_value", expectedValueType: "unknown_secret" }, validation: { minimumLength: 1, maximumLength: 100 } }, storage: { credentialName: "Secret", scope: "project" } },
  ], timeoutMs: 1000, scheduling: "fair_shared_timeout" },
  acquisitionReadiness: { ceremonyIntent: intent, expectedContainerModel: { version: 2, digest: "a".repeat(64), concept: "target", scopeKind: "page", capabilityDigest: "b".repeat(64), structuralPath: [] }, valueIntent: intent, approvedMethods: ["text_content"], minimumConfidence: 0.5, minimumConfidenceMargin: 0, recoveryPolicy: "secure_assistance", recoveryWindowMs: 1000 },
  continuation: { strategies: [{ mode: "terminal" }] },
};

describe("external resource binding contract", () => {
  it("accepts a typed response identity backed by a public project output", () => {
    expect(protectedTransactionSchema.parse({ ...transaction, extraction: { ...transaction.extraction, externalResourceBindings: [{ status: "active", identityReference: "publicId", provider: "provider", resourceKind: "credential_record", resourceScope: "application-a", identityContractVersion: 1, identitySource: "response", requiredForDestructiveLifecycle: true }] } }).extraction.externalResourceBindings).toHaveLength(1);
  });
  it("rejects a protected output as external identity", () => {
    expect(() => protectedTransactionSchema.parse({ ...transaction, extraction: { ...transaction.extraction, externalResourceBindings: [{ status: "active", identityReference: "secret", provider: "provider", resourceKind: "credential_record", resourceScope: "application-a", identityContractVersion: 1, identitySource: "response", requiredForDestructiveLifecycle: true }] } })).toThrow();
  });
  it("accepts an explicit unavailable binding without identity", () => {
    expect(() => protectedTransactionSchema.parse({ ...transaction, extraction: { ...transaction.extraction, externalResourceBindings: [{ status: "unavailable", provider: "provider", resourceKind: "credential_record", resourceScope: "application-a", identityContractVersion: 1, requiredForDestructiveLifecycle: true }] } })).not.toThrow();
  });

  it("accepts an explicit public current-projection presentation contract", () => {
    expect(externalResourcePresentationContractSchema.parse({
      canonicalIdentity: { source: "external_resource_binding" },
      resource: { provider: "provider", kind: "credential", scope: "application-a" },
      presentationObservation: {
        source: "authoritative_read_only_resource_observation",
        resourceCollection: "application_credentials",
      },
      presentationIdentity: {
        semanticField: "label", classification: "internal_non_secret", stability: "current_projection",
      },
      browserBoundary: { kind: "row" },
      action: {
        concept: "revoke credential", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: ["Revoke"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
        scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
        risk: "destructive", confidence: { requiredFamilies: [] }, matching: "exact",
      },
    }).presentationIdentity).toEqual({
      semanticField: "label", classification: "internal_non_secret", stability: "current_projection",
    });
  });

  it.each([
    { presentationIdentity: { semanticField: "label", classification: "protected", stability: "current_projection" } },
    { presentationIdentity: { semanticField: "label", classification: "public", stability: "durable" } },
  ])("rejects an unsafe presentation declaration: %o", (override) => {
    expect(() => externalResourcePresentationContractSchema.parse({
      canonicalIdentity: { source: "external_resource_binding" },
      resource: { provider: "provider", kind: "credential", scope: "application-a" },
      presentationObservation: {
        source: "authoritative_read_only_resource_observation",
        resourceCollection: "application_credentials",
      },
      ...override,
      browserBoundary: { kind: "row" },
      action: {
        concept: "revoke credential", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: ["Revoke"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
        scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
        risk: "destructive", confidence: { requiredFamilies: [] }, matching: "exact",
      },
    })).toThrow();
  });

  it("prevents ordinary environment updates and live harnesses from authoring presentation authority", () => {
    expect(() => updateEnvironmentSchema.parse({
      missionId: "11111111-1111-4111-8111-111111111111",
      objectiveId: "22222222-2222-4222-8222-222222222222",
      agentSessionId: "33333333-3333-4333-8333-333333333333",
      baseOrigin: "https://example.test",
      policy: {
        allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
        allowDownloads: false, allowPopups: false, maxActions: 1,
        maxDurationMs: 10_000, maxNavigations: 1,
        externalResourcePresentationAuthorities: [],
      },
      secretRefs: [],
    })).toThrow();
  });
});
