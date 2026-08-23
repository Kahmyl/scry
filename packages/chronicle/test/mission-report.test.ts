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
});
