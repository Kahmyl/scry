import { describe, expect, it, vi } from "vitest";

import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";

const principal = { kind: "service", workspaceId: null } as never;

function fixture(expectedEffect: Record<string, unknown>, registry?: Record<string, unknown>) {
  const sessions = {
    beginUnknownReconciliation: vi.fn(async () => ({
      state: "observing", id: "attempt", attempt: 1, replayed: false, expectedEffect,
      authority: { action: { type: "waitFor" } },
    })),
    completeUnknownReconciliation: vi.fn(async () => ({ missionFenceCleared: false })),
    prepareRuntimeRestoration: vi.fn(async () => ({ state: "provisioning", replayed: false })),
    get: vi.fn(async () => ({ state: "provisioning" })),
    activateProvisionedSession: vi.fn(async () => undefined),
  };
  const runner = { initialize: vi.fn(async () => undefined), close: vi.fn(async () => undefined), hasRuntime: vi.fn(() => false),
    reconcileUnknownEffect: vi.fn(async () => ({
    result: "proven_applied", reasonCode: "RECONCILIATION_NAVIGATION_PROVEN",
    evidence: { observedUrl: "https://example.test/done" },
  })) };
  const service = new MissionFlowAuthoringService(
    sessions as never, runner as never,
    { assertAcceptingWork: vi.fn(async () => undefined) } as never,
    undefined,
    registry as never,
  );
  return { service, sessions, runner };
}

describe("authoritative UNKNOWN reconciliation", () => {
  it("returns STILL_UNKNOWN for an effectless operation without invoking the browser", async () => {
    const { service, sessions, runner } = fixture({ type: "none" });
    const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
      missionId: "00000000-0000-4000-8000-000000000002", operationId: "uncertain",
      idempotencyKey: "reconcile-unknown-1",
    });
    expect(result).toMatchObject({ result: "still_unknown", redispatchAllowed: false, missionFenceCleared: false });
    expect(runner.reconcileUnknownEffect).not.toHaveBeenCalled();
    expect(sessions.completeUnknownReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      result: "still_unknown", reasonCode: "RECONCILIATION_EXPECTED_EFFECT_UNAVAILABLE",
    }));
  });

  it("accepts only the runner's authoritative observation result", async () => {
    const { service, sessions, runner } = fixture({ type: "navigation", url: "https://example.test/done", match: "exact" });
    const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
      missionId: "00000000-0000-4000-8000-000000000002", operationId: "uncertain",
      idempotencyKey: "reconcile-unknown-2",
    });
    expect(result).toMatchObject({ result: "proven_applied", redispatchAllowed: false });
    expect(runner.reconcileUnknownEffect).toHaveBeenCalledOnce();
    expect(sessions.completeUnknownReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      result: "proven_applied",
    }));
  });

  it.each(["proven_applied", "proven_not_applied"] as const)(
    "accepts %s only from a registered authoritative resource read without browser dispatch",
    async (authoritativeResult) => {
      const registry = { reconcile: vi.fn(async () => authoritativeResult === "proven_applied" ? ({ result: authoritativeResult,
        reasonCode: "AUTHORITATIVE_RESOURCE_READ", resource: { provider: "example", resourceKind: "order",
          resourceScope: "orders", identity: "order-1", state: "active" }, outputState: "not_applicable",
        evidence: { providerCorrelation: "opaque" } }) : ({ result: authoritativeResult,
        reasonCode: "AUTHORITATIVE_RESOURCE_READ", evidence: { providerCorrelation: "opaque" } })) };
      const { service, runner } = fixture({ type: "network_outcome", urlPattern: "/orders", statusMin: 200, statusMax: 299 }, registry);
      const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
        missionId: "00000000-0000-4000-8000-000000000002", operationId: "uncertain-resource",
        idempotencyKey: `resource-${authoritativeResult}`,
      });
      expect(result).toMatchObject({ result: authoritativeResult, redispatchAllowed: false });
      expect(registry.reconcile).toHaveBeenCalledOnce();
      expect(runner.reconcileUnknownEffect).not.toHaveBeenCalled();
    },
  );

  it("keeps applied-but-unrecovered protected output fenced and exposes only factual cleanup context", async () => {
    const registry = { reconcile: vi.fn(async () => ({
      result: "proven_applied_output_unrecovered", reasonCode: "RESOURCE_PRESENT_OUTPUT_UNRECOVERED",
      resource: { provider: "vitract", resourceKind: "credential_record", resourceScope: "app",
        identity: "credential-1", state: "active" }, outputState: "unrecovered",
      evidence: { authoritative: true },
    })) };
    const { service, sessions, runner } = fixture({ type: "none" }, registry);
    const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
      missionId: "00000000-0000-4000-8000-000000000002", operationId: "uncertain-resource",
      idempotencyKey: "resource-output-unrecovered",
    });
    expect(result).toMatchObject({ result: "proven_applied_output_unrecovered", missionFenceCleared: false,
      redispatchAllowed: false, safeActions: ["get_flow_authoring"],
      resourceEffect: { outputState: "unrecovered", resource: { identity: "credential-1" } } });
    expect(runner.reconcileUnknownEffect).not.toHaveBeenCalled();
    expect(sessions.completeUnknownReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      result: "proven_applied_output_unrecovered",
    }));
  });

  it("mechanically clears mutation fencing for a durable read-only dispatch without claiming its functional effect", async () => {
    const { service, sessions, runner } = fixture({ type: "navigation", url: "https://example.test/done", match: "exact" });
    sessions.beginUnknownReconciliation.mockResolvedValueOnce({
      state: "observing", id: "attempt", attempt: 1, replayed: false,
      expectedEffect: { type: "navigation", url: "https://example.test/done", match: "exact" },
      authority: { action: { type: "click", dispatchSemantics: "read_only" } as never },
    });
    const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
      missionId: "00000000-0000-4000-8000-000000000002", operationId: "read-only-unknown",
      idempotencyKey: "read-only-reconcile",
    });
    expect(result).toMatchObject({ result: "proven_not_applied", redispatchAllowed: false,
      reasonCode: "READ_ONLY_DISPATCH_HAS_NO_MUTATION_EFFECT" });
    expect(runner.reconcileUnknownEffect).not.toHaveBeenCalled();
  });

  it("applies the same mechanical reconciliation to targeted read-only key activation", async () => {
    const { service, sessions, runner } = fixture({ type: "none" });
    sessions.beginUnknownReconciliation.mockResolvedValueOnce({
      state: "observing", id: "attempt", attempt: 1, replayed: false,
      expectedEffect: { type: "none" },
      authority: { action: { type: "press", key: "Enter", dispatchSemantics: "read_only" } as never },
    });
    const result = await service.reconcileUnknown(principal, "00000000-0000-4000-8000-000000000001", {
      missionId: "00000000-0000-4000-8000-000000000002", operationId: "read-only-press-unknown",
      idempotencyKey: "read-only-press-reconcile",
    });
    expect(result).toMatchObject({ result: "proven_not_applied", redispatchAllowed: false,
      reasonCode: "READ_ONLY_DISPATCH_HAS_NO_MUTATION_EFFECT" });
    expect(runner.reconcileUnknownEffect).not.toHaveBeenCalled();
  });

});
