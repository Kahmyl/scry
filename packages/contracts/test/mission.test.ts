import { describe, expect, it } from "vitest";
import {
  acceptEvidenceSchema,
  createMissionSchema,
  missionResumePointerSchema,
  publishMissionReportSchema,
} from "../src/index.js";

const ids = {
  missionId: "11111111-1111-4111-8111-111111111111",
  objectiveId: "22222222-2222-4222-8222-222222222222",
  agentSessionId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
};
describe("Mission contracts", () => {
  it("requires durable instruction identity", () => {
    expect(
      createMissionSchema.safeParse({
        title: "Partner workflow",
        originalInstruction: "Test it",
        instructionSnapshot: "Test it",
        provider: "codex",
        idempotencyKey: "mission-key-1",
      }).success,
    ).toBe(true);
    expect(
      createMissionSchema.safeParse({
        title: "Missing instruction",
        idempotencyKey: "mission-key-2",
      }).success,
    ).toBe(false);
  });
  it("rejects an unscoped resume target", () => {
    expect(
      missionResumePointerSchema.safeParse({
        objectiveId: ids.objectiveId,
        recommendedAction: "run_candidate",
        runId: "not-a-uuid",
        explanation: "Run it",
      }).success,
    ).toBe(false);
  });
  it("requires factual durable context for a non-terminal human wait", () => {
    const pointer = {
      objectiveId: ids.objectiveId,
      recommendedAction: "await_user",
      explanation: "Trust-policy authorization is pending",
      externalInput: {
        condition: "USER_AUTHORIZATION_REQUIRED",
        cause: "The requested origin is not in the active environment policy.",
        affectedOperation: "policy-change-1",
        effectState: "not_applied",
        authority: {
          required: true,
          type: "user",
          reason: "Only the user may authorize this policy change.",
        },
        availableCapabilities: [
          "grant_mission_execution_authorization",
          "resume_mission",
          "cancel_mission_orchestration",
        ],
        constraints: ["No browser mutation may continue while waiting."],
        consequences: [
          "Authorization permits revalidation; it does not bypass later policy checks.",
        ],
        continuation: {
          retryCurrentOperation: false,
          freshObservationRequired: true,
          newOperationRequired: true,
          newDraftRequired: false,
          newSessionRequired: false,
        },
        waiting: true,
        terminal: false,
        resumeRef: ids.objectiveId,
      },
    } as const;
    expect(missionResumePointerSchema.safeParse(pointer).success).toBe(true);
    expect(
      missionResumePointerSchema.safeParse({
        objectiveId: ids.objectiveId,
        recommendedAction: "await_user",
        explanation: "Wait",
      }).success,
    ).toBe(false);
    expect(
      missionResumePointerSchema.safeParse({
        ...pointer,
        externalInput: { ...pointer.externalInput, terminal: true },
      }).success,
    ).toBe(false);
  });
  it("requires explicit accepted evidence context", () => {
    expect(
      acceptEvidenceSchema.safeParse({
        missionId: ids.missionId,
        agentSessionId: ids.agentSessionId,
        runId: ids.runId,
        artifactIds: [],
        conclusion: "Passed",
      }).success,
    ).toBe(true);
    expect(
      acceptEvidenceSchema.safeParse({ runId: ids.runId, artifactIds: [], conclusion: "Passed" })
        .success,
    ).toBe(false);
  });
  it("requires optimistic report publication", () => {
    expect(
      publishMissionReportSchema.safeParse({
        missionId: ids.missionId,
        agentSessionId: ids.agentSessionId,
        overallConclusion: "Complete",
        journeySummary: ["Passed"],
        remainingActions: [],
        expectedRevision: 3,
      }).success,
    ).toBe(true);
  });
});
