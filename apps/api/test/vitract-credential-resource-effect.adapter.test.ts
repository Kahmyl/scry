import { describe, expect, it, vi } from "vitest";

import {
  VitractCredentialResourceEffectAdapter,
  type UnknownOperationAuthority,
} from "../src/adaptive-sessions/index.js";

function authority(): UnknownOperationAuthority {
  return {
    projectId: "project", environmentId: "environment", missionId: "mission", objectiveId: "objective",
    flowDraftId: "flow", sessionId: "session", operationId: "operation", idempotencyKey: "dispatch-key",
    dispatchBoundary: "acknowledged", dispatchIdentity: { operationCreatedAt: "2026-08-16T00:00:00Z" },
    expectedEffect: { type: "none" }, baseline: null,
    action: { type: "protectedTransaction", operationId: "operation",
      entry: { url: "https://preview.vitract.com/partner/developer/applications/app-1/credentials", assertions: [] },
    } as never,
    authoringIntent: { action: { kind: "acquire_protected_outputs", preparationIntentIds: ["label"],
      mutation: { kind: "one_time", target: { concept: "add", exact: true } },
      outputs: [{ reference: "secret", classification: "protected", target: { concept: "secret", exact: true }, storageName: "secret" }],
    } } as never,
    preparationFacts: [{ intentId: "label", actionKind: "fill", publicValue: "unique-label" }],
  };
}

describe("Vitract credential resource-effect adapter", () => {
  it("reports exact applied identity while preserving unrecovered output truth", async () => {
    const observe = vi.fn(async () => ({ source: "authoritative_supported_resource_listing" as const,
      observationId: "observation-1", records: [{ identity: "credential-1", label: "unique-label", state: "active" }] }));
    const adapter = new VitractCredentialResourceEffectAdapter(observe);
    await expect(adapter.observe(authority())).resolves.toMatchObject({
      result: "proven_applied_output_unrecovered", outputState: "unrecovered",
      resource: { identity: "credential-1", state: "active" },
    });
    expect(observe).toHaveBeenCalledOnce();
  });

  it("never upgrades absence without an authoritative pre-dispatch resource baseline", async () => {
    const adapter = new VitractCredentialResourceEffectAdapter(async () => ({
      source: "authoritative_supported_resource_listing", observationId: "observation-2", records: [],
    }));
    await expect(adapter.observe(authority())).resolves.toMatchObject({
      result: "still_unknown", reasonCode: "AUTHORITATIVE_RESOURCE_ABSENCE_WITHOUT_BASELINE",
    });
  });

  it("keeps duplicate correlation ambiguous and performs only one read", async () => {
    const observe = vi.fn(async () => ({ source: "authoritative_supported_resource_listing" as const,
      observationId: "observation-3", records: [
        { identity: "credential-1", label: "unique-label", state: "active" },
        { identity: "credential-2", label: "unique-label", state: "active" },
      ] }));
    const adapter = new VitractCredentialResourceEffectAdapter(observe);
    await expect(adapter.observe(authority())).resolves.toMatchObject({
      result: "still_unknown", reasonCode: "AUTHORITATIVE_RESOURCE_CORRELATION_AMBIGUOUS",
    });
    expect(observe).toHaveBeenCalledOnce();
  });
});
