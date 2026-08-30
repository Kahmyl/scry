import { describe, expect, it } from "vitest";

import {
  decideMissionSelection,
  type MissionSelectionFact,
} from "../src/missions/mission-selection-policy.js";

const currentExternalRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherExternalRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fact(overrides: Partial<MissionSelectionFact> = {}): MissionSelectionFact {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Evaluate the application",
    status: "blocked",
    purpose: "primary",
    latestExternalRunId: otherExternalRunId,
    latestAgentSessionStatus: "interrupted",
    knownExternalRunIds: [otherExternalRunId],
    activeExternalRunIds: [],
    activeExecutionOwnership: false,
    unresolvedMutationRisk: false,
    outstandingReconciliation: false,
    ...overrides,
  };
}

describe("canonical Mission-selection policy", () => {
  it("admits a fresh primary Mission when no plausible Mission exists", () => {
    expect(
      decideMissionSelection({ currentExternalRunId, intendedPurpose: "primary", candidates: [] }),
    ).toMatchObject({
      decision: "fresh_primary_permitted",
      freshPrimaryMissionPermitted: true,
      userAuthorityRequired: false,
    });
  });

  it("reproduces run #2 and admits fresh primary work over settled blocked history", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [fact()],
      }),
    ).toMatchObject({
      decision: "fresh_primary_permitted",
      freshPrimaryMissionPermitted: true,
      continuationAvailable: false,
      userAuthorityRequired: false,
      candidates: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          classification: "settled_history",
          unresolvedMutationRisk: false,
          outstandingReconciliation: false,
        },
      ],
    });
  });

  it("does not admit duplicate primary work over unresolved UNKNOWN truth", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [fact({ unresolvedMutationRisk: true })],
      }),
    ).toMatchObject({
      decision: "selection_required",
      freshPrimaryMissionPermitted: false,
      blockerCode: "MISSION_MUTATION_RECONCILIATION_REQUIRED",
      candidates: [{ classification: "mutation_reconciliation_required" }],
    });
  });

  it("does not admit duplicate primary work over outstanding reconciliation", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [fact({ outstandingReconciliation: true })],
      }),
    ).toMatchObject({
      decision: "selection_required",
      freshPrimaryMissionPermitted: false,
      blockerCode: "MISSION_MUTATION_RECONCILIATION_REQUIRED",
    });
  });

  it("exposes same-run active ownership as continuation and never creates a duplicate", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [
          fact({
            status: "running",
            latestExternalRunId: currentExternalRunId,
            latestAgentSessionStatus: "active",
            activeExternalRunIds: [currentExternalRunId],
            activeExecutionOwnership: true,
          }),
        ],
      }),
    ).toMatchObject({
      decision: "continuation_available",
      freshPrimaryMissionPermitted: false,
      continuationAvailable: true,
      userAuthorityRequired: false,
      candidates: [{ classification: "same_run_continuation" }],
    });
  });

  it("requires selection rather than stealing active ownership from another run", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [
          fact({
            status: "running",
            latestAgentSessionStatus: "active",
            activeExternalRunIds: [otherExternalRunId],
            activeExecutionOwnership: true,
          }),
        ],
      }),
    ).toMatchObject({
      decision: "selection_required",
      blockerCode: "MISSION_SELECTION_REQUIRED",
      userAuthorityRequired: true,
      candidates: [{ classification: "active_other_run" }],
    });
  });

  it("requires selection when multiple plausible active Missions exist", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [
          fact({
            id: "11111111-1111-4111-8111-111111111111",
            status: "running",
            activeExternalRunIds: [otherExternalRunId],
            activeExecutionOwnership: true,
          }),
          fact({
            id: "22222222-2222-4222-8222-222222222222",
            status: "planning",
            latestExternalRunId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            activeExternalRunIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
            activeExecutionOwnership: true,
          }),
        ],
      }),
    ).toMatchObject({
      decision: "selection_required",
      blockerCode: "MISSION_SELECTION_REQUIRED",
      freshPrimaryMissionPermitted: false,
    });
  });

  it("treats completed history as history for a distinct fresh external run", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [fact({ status: "completed", latestAgentSessionStatus: "completed" })],
      }),
    ).toMatchObject({
      decision: "fresh_primary_permitted",
      freshPrimaryMissionPermitted: true,
      candidates: [{ classification: "settled_history" }],
    });
  });

  it("honors explicit distinct-work authority over settled history without an external run ID", () => {
    expect(
      decideMissionSelection({
        intendedPurpose: "primary",
        distinctAuthorityConfirmed: true,
        candidates: [fact({ status: "completed", latestAgentSessionStatus: "completed" })],
      }),
    ).toMatchObject({
      decision: "fresh_primary_permitted",
      freshPrimaryMissionPermitted: true,
      userAuthorityRequired: false,
      candidates: [{ classification: "settled_history" }],
    });
  });

  it("does not let distinct-work authority override active ownership or mutation reconciliation", () => {
    const inputs = [
      fact({ status: "running", activeExecutionOwnership: true }),
      fact({ unresolvedMutationRisk: true }),
    ];

    for (const candidate of inputs)
      expect(
        decideMissionSelection({
          intendedPurpose: "primary",
          distinctAuthorityConfirmed: true,
          candidates: [candidate],
        }).freshPrimaryMissionPermitted,
      ).toBe(false);
  });

  it("refuses reuse of a settled external-run identity", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [
          fact({
            latestExternalRunId: currentExternalRunId,
            latestAgentSessionStatus: "interrupted",
          }),
        ],
      }),
    ).toMatchObject({
      decision: "selection_required",
      blockerCode: "EXTERNAL_AGENT_RUN_ALREADY_SETTLED",
      freshPrimaryMissionPermitted: false,
      candidates: [{ classification: "same_run_settled" }],
    });
  });

  it("refuses a settled external-run identity even when a newer session exists", () => {
    expect(
      decideMissionSelection({
        currentExternalRunId,
        intendedPurpose: "primary",
        candidates: [
          fact({
            latestExternalRunId: otherExternalRunId,
            knownExternalRunIds: [currentExternalRunId, otherExternalRunId],
          }),
        ],
      }),
    ).toMatchObject({
      decision: "selection_required",
      blockerCode: "EXTERNAL_AGENT_RUN_ALREADY_SETTLED",
      candidates: [{ classification: "same_run_settled" }],
    });
  });

  it("keeps diagnostic and recovery creation behind explicit distinct authority", () => {
    for (const intendedPurpose of ["diagnostic", "recovery"] as const) {
      expect(
        decideMissionSelection({
          currentExternalRunId,
          intendedPurpose,
          candidates: [fact()],
        }),
      ).toMatchObject({
        decision: "selection_required",
        blockerCode: "MISSION_DISTINCT_WORK_AUTHORITY_REQUIRED",
        freshPrimaryMissionPermitted: false,
        userAuthorityRequired: true,
      });
    }
  });
});
