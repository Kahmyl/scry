import { describe, expect, it, vi } from "vitest";

import {
  classifyHistoricalOperationAuthority,
  classifyHistoricalReconciliationAuthority,
} from "../src/adaptive-sessions/historical-operation-authority.js";
import { decideRuntimeLossDisposition } from "../src/adaptive-sessions/runtime-loss-disposition.js";
import { loadConflictScope } from "../src/recovery/conflict-scope.repository.js";

describe("Milestone 4 recovery and lifecycle authority", () => {
  it.each([
    [null, "malformed_authority", "RECONCILIATION_ACTION_MISSING"],
    [undefined, "malformed_authority", "RECONCILIATION_ACTION_MISSING"],
    [{}, "malformed_authority", "RECONCILIATION_ACTION_MALFORMED"],
    [
      { type: "legacyClick", selector: "#submit" },
      "unsupported_historical_authority",
      "RECONCILIATION_ACTION_UNSUPPORTED",
    ],
  ])("fails historical authority closed without fabrication", (value, kind, reasonCode) => {
    expect(classifyHistoricalOperationAuthority(value)).toEqual({ kind, reasonCode });
  });

  it("accepts only a current typed historical action", () => {
    expect(
      classifyHistoricalOperationAuthority({ type: "navigate", url: "https://example.test" }),
    ).toEqual({
      kind: "usable_authority",
      action: { type: "navigate", url: "https://example.test" },
    });
  });

  it.each([
    [
      { expectedEffect: { type: "broken" }, baseline: {}, localEvidence: null },
      "RECONCILIATION_EXPECTED_EFFECT_MALFORMED",
    ],
    [
      {
        expectedEffect: { type: "navigation", url: "https://example.test" },
        baseline: null,
        localEvidence: null,
      },
      "RECONCILIATION_BASELINE_MISSING",
    ],
    [
      { expectedEffect: { type: "none" }, baseline: null, localEvidence: { activeBinding: null } },
      "RECONCILIATION_PROVIDER_BINDING_MISSING",
    ],
  ] as const)("classifies insufficient durable recovery facts: %s", (facts, reasonCode) => {
    expect(
      classifyHistoricalReconciliationAuthority({
        action: { type: "navigate", url: "https://example.test" },
        ...facts,
      }),
    ).toEqual({ kind: "insufficient_reconciliation_authority", reasonCode });
  });

  it.each([
    ["A", true, true, "not_applied", "not_dispatched", "active", "owned"],
    ["B", false, false, "not_applied", "not_dispatched", "failed", "closed"],
    ["C", false, true, "unknown", "dispatched", "recovery_required", "recovery_required"],
    ["D", true, true, "unknown", "dispatched", "active", "owned"],
    ["E", false, false, "not_applied", "not_dispatched", "failed", "closed"],
    ["F", false, false, "unknown", "dispatching", "recovery_required", "recovery_required"],
    ["G", false, false, "applied", "acknowledged", "recovery_required", "recovery_required"],
    ["H", true, true, "unknown", "dispatched", "active", "owned"],
    ["I", false, false, "unknown", "dispatched", "recovery_required", "recovery_required"],
    ["J", false, false, "unknown", "dispatched", "recovery_required", "recovery_required"],
  ] as const)(
    "applies lifecycle matrix %s without changing mutation truth",
    (_case, runtimePresent, leaseValid, mutation, dispatchBoundary, praxisState, runtimeTruth) => {
      expect(
        decideRuntimeLossDisposition({
          praxisState: "active",
          runtimePresent,
          leaseValid,
          dispatchBoundary,
          canonicalMutationTruth: mutation,
          recoveryObservationAvailable: false,
        }),
      ).toMatchObject({ praxisState, runtimeTruth });
    },
  );

  it("returns typed project-scoped blockers and keeps expired ownership non-blocking", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rowCount: 2,
      rows: [
        {
          kind: "adaptive_unknown",
          projectId: values?.[0],
          missionId: "mission-related",
          environmentId: null,
          resourceDomain: null,
          credentialDomain: null,
          operationId: "operation-1",
          protectedOperationId: null,
          recoveryId: null,
          authority: "adaptive",
          blocking: true,
          lifecycle: "recovery_required",
        },
        {
          kind: "external_agent_owner",
          projectId: values?.[0],
          missionId: "mission-history",
          environmentId: null,
          resourceDomain: null,
          credentialDomain: null,
          operationId: null,
          protectedOperationId: null,
          recoveryId: null,
          authority: "lifecycle",
          blocking: false,
          lifecycle: "expired",
        },
      ],
    }));
    const blockers = await loadConflictScope(query as never, { projectId: "project-a" });
    expect(blockers).toEqual([
      expect.objectContaining({
        projectId: "project-a",
        missionId: "mission-related",
        blocking: true,
      }),
      expect.objectContaining({ lifecycle: "expired", blocking: false }),
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual(["project-a", null, null, null, null]);
  });
});
