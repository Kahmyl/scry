import { describe, expect, it, vi } from "vitest";
import { AdaptiveOperationReconciliationRegistry, type UnknownOperationAuthority } from
  "../src/adaptive-sessions/adaptive-operation-reconciliation.registry.js";

const authority = {
  projectId: "project", environmentId: "environment", missionId: "mission", objectiveId: "objective",
  flowDraftId: "flow", sessionId: "session", operationId: "operation",
  action: { type: "waitFor" },
  expectedEffect: { type: "network_outcome", urlPattern: "/orders", statusMin: 200, statusMax: 299 },
  idempotencyKey: "original-dispatch", dispatchBoundary: "dispatched",
  dispatchIdentity: { operationCreatedAt: "2026-08-14T00:00:00.000Z" },
  baseline: { url: "https://example.test", documentEpoch: 1, effectState: { state: "unsupported" } },
} as unknown as UnknownOperationAuthority;

describe("authoritative resource reconciliation registry", () => {
  it("requires exactly one provider supporting the complete durable correlation", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    const observe = vi.fn(async () => ({ result: "proven_applied" as const,
      reasonCode: "RESOURCE_PRESENT", resource: { provider: "example", resourceKind: "order",
        resourceScope: "orders", identity: "order-1", state: "active" },
      outputState: "not_applicable" as const, evidence: { authoritative: true } }));
    registry.register({ id: "orders", supports: (candidate) => candidate.projectId === "project"
      && candidate.environmentId === "environment" && candidate.missionId === "mission"
      && candidate.sessionId === "session" && candidate.operationId === "operation"
      && candidate.idempotencyKey === "original-dispatch", observe });
    expect(registry.available(authority)).toBe(true);
    await expect(registry.reconcile(authority)).resolves.toMatchObject({ result: "proven_applied" });
    expect(observe).toHaveBeenCalledOnce();
  });

  it("permits a resource provider for an effectless browser operation", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    const effectless = { ...authority, expectedEffect: { type: "none" as const } };
    registry.register({ id: "resource", supports: () => true, observe: async () => ({
      result: "proven_not_applied", reasonCode: "AUTHORITATIVE_ABSENCE_WITH_BASELINE",
      evidence: { authoritative: true },
    }) });
    await expect(registry.reconcile(effectless)).resolves.toMatchObject({ result: "proven_not_applied" });
  });

  it("rejects provider claims that omit exact resource identity", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    registry.register({ id: "invalid", supports: () => true, observe: async () => ({
      result: "proven_applied", reasonCode: "RESOURCE_PRESENT", evidence: { authoritative: true },
    } as never) });
    await expect(registry.reconcile(authority)).rejects.toThrow();
  });

  it("upgrades provider output recovery only from complete committed identity-matched local evidence", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    registry.register({ id: "orders", supports: () => true, observe: async () => ({
      result: "proven_applied_output_unrecovered",
      reasonCode: "RESOURCE_PRESENT_OUTPUT_UNRECOVERED",
      resource: { provider: "example", resourceKind: "order", resourceScope: "orders", identity: "order-1", state: "active" },
      outputState: "unrecovered",
      evidence: { authoritative: true },
    }) });
    const qualified = {
      ...authority,
      localEvidence: {
        mutationOutcome: "applied" as const,
        acquisitionState: "complete" as const,
        persistenceState: "committed" as const,
        requiredOutputReferences: ["orderId", "secret"],
        persistedReferences: { orderId: {}, secret: {} },
        activeBinding: {
          provider: "example", resourceKind: "order", resourceScope: "orders",
          canonicalExternalIdentity: "order-1",
        },
      },
    };
    await expect(registry.reconcile(qualified)).resolves.toMatchObject({
      result: "proven_applied",
      outputState: "usable",
      reasonCode: "AUTHORITATIVE_RESOURCE_AND_LOCAL_OUTPUTS_PRESENT",
    });
  });

  it("preserves unrecovered provider truth when local persistence or binding identity is incomplete", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    registry.register({ id: "orders", supports: () => true, observe: async () => ({
      result: "proven_applied_output_unrecovered",
      reasonCode: "RESOURCE_PRESENT_OUTPUT_UNRECOVERED",
      resource: { provider: "example", resourceKind: "order", resourceScope: "orders", identity: "order-1", state: "active" },
      outputState: "unrecovered",
      evidence: { authoritative: true },
    }) });
    await expect(registry.reconcile({
      ...authority,
      localEvidence: {
        mutationOutcome: "applied", acquisitionState: "complete", persistenceState: "committed",
        requiredOutputReferences: ["orderId", "secret"], persistedReferences: { orderId: {} },
        activeBinding: { provider: "example", resourceKind: "order", resourceScope: "orders", canonicalExternalIdentity: "different" },
      },
    })).resolves.toMatchObject({ result: "proven_applied_output_unrecovered" });
  });

  it("does not observe for ownership mismatch or ambiguous provider authority", async () => {
    const registry = new AdaptiveOperationReconciliationRegistry();
    const first = vi.fn(); const second = vi.fn();
    registry.register({ id: "wrong-owner", supports: (candidate) => candidate.projectId === "other", observe: first });
    expect(registry.available(authority)).toBe(false);
    await expect(registry.reconcile(authority)).resolves.toBeNull();
    registry.register({ id: "one", supports: () => true, observe: first });
    registry.register({ id: "two", supports: () => true, observe: second });
    expect(registry.available(authority)).toBe(false);
    await expect(registry.reconcile(authority)).resolves.toBeNull();
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });
});
