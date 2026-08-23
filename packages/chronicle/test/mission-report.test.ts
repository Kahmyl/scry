import { describe, expect, it } from "vitest";

import { digestMissionReportComposition } from "../src/mission/report.js";

const missionId = "11111111-1111-4111-8111-111111111111";
const selectedRunId = "22222222-2222-4222-8222-222222222222";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: "33333333-3333-4333-8333-333333333333",
    correlation: { missionId, runId: selectedRunId },
    ...overrides,
  } as never;
}

function input(mutationReceipts = [receipt()]) {
  return {
    missionId,
    sourceMissionRevision: 7,
    selectedRunIds: [selectedRunId],
    evidenceDigest: "a".repeat(64),
    recordingDigest: "b".repeat(64),
    mutationReceipts,
    relatedMissions: [],
  };
}

describe("Mission report composition digest", () => {
  it("deterministically binds the selected factual projections", () => {
    const first = digestMissionReportComposition(input());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(digestMissionReportComposition(input())).toBe(first);
  });

  it("rejects receipts from another Mission or an unselected Run", () => {
    expect(() =>
      digestMissionReportComposition(
        input([
          receipt({
            correlation: {
              missionId: "44444444-4444-4444-8444-444444444444",
              runId: selectedRunId,
            },
          }),
        ]),
      ),
    ).toThrow("CHRONICLE_REPORT_MUTATION_RECEIPT_MISSION_MISMATCH");

    expect(() =>
      digestMissionReportComposition(
        input([
          receipt({
            correlation: {
              missionId,
              runId: "55555555-5555-4555-8555-555555555555",
            },
          }),
        ]),
      ),
    ).toThrow("CHRONICLE_REPORT_MUTATION_RECEIPT_RUN_UNSELECTED");
  });

  it("rejects duplicate receipt or selected Run identity", () => {
    expect(() => digestMissionReportComposition(input([receipt(), receipt()]))).toThrow(
      "CHRONICLE_REPORT_MUTATION_RECEIPT_DUPLICATE",
    );
    expect(() =>
      digestMissionReportComposition({
        ...input([]),
        selectedRunIds: [selectedRunId, selectedRunId],
      }),
    ).toThrow("CHRONICLE_REPORT_SELECTED_RUN_DUPLICATE");
  });

  it("binds relation disclosure and rejects duplicate or self-referential provenance", () => {
    const relation = {
      relationId: "66666666-6666-4666-8666-666666666666",
      relation: "diagnoses" as const,
      direction: "incoming" as const,
      reason: "Diagnostic provenance",
      createdAt: "2026-08-23T17:00:00.000Z",
      relatedMission: {
        id: "77777777-7777-4777-8777-777777777777",
        purpose: "diagnostic" as const,
        status: "blocked" as const,
      },
      unresolvedProtectedOperations: [],
    };
    const withRelation = { ...input([]), relatedMissions: [relation] };
    expect(digestMissionReportComposition(withRelation)).not.toBe(
      digestMissionReportComposition(input([])),
    );
    expect(() =>
      digestMissionReportComposition({ ...withRelation, relatedMissions: [relation, relation] }),
    ).toThrow("CHRONICLE_REPORT_MISSION_RELATION_DUPLICATE");
    expect(() =>
      digestMissionReportComposition({
        ...withRelation,
        relatedMissions: [
          { ...relation, relatedMission: { ...relation.relatedMission, id: missionId } },
        ],
      }),
    ).toThrow("CHRONICLE_REPORT_MISSION_RELATION_SELF_REFERENCE");
  });
});
