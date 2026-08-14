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
      reasonCode: "RESOURCE_PRESENT", evidence: { authoritative: true } }));
    registry.register({ id: "orders", supports: (candidate) => candidate.projectId === "project"
      && candidate.environmentId === "environment" && candidate.missionId === "mission"
      && candidate.sessionId === "session" && candidate.operationId === "operation"
      && candidate.idempotencyKey === "original-dispatch", observe });
    expect(registry.available(authority)).toBe(true);
    await expect(registry.reconcile(authority)).resolves.toMatchObject({ result: "proven_applied" });
    expect(observe).toHaveBeenCalledOnce();
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
