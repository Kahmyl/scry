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
        fulfillmentPaths: [{
          kind: "approval",
          humanAction: "Approve the disclosed policy change.",
          agentExposure: "authorization_only",
          result: "User authority becomes available for policy revalidation.",
          availableCapabilities: ["grant_mission_execution_authorization", "resume_mission"],
          continuation: { sameMission: true, sameObjective: true,
            replacementMissionRequired: false, resumeWith: "resume_mission" },
        }],
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
        lifecycle: { terminal: false, taskStillActive: true, sameMissionResumable: true,
          sameObjectiveResumable: true, shouldFinalize: false, shouldPublishFinalReport: false,
          shouldCreateReplacementMission: false,
          requiredNextStep: "fulfill_human_prerequisite_then_resume" },
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
  it("advertises both protected-credential trust paths without implying equal exposure", () => {
    const sharedContinuation = { sameMission: true, sameObjective: true,
      replacementMissionRequired: false, resumeWith: "resume_mission" } as const;
    const pointer = {
      objectiveId: ids.objectiveId,
      recommendedAction: "await_user",
      explanation: "A protected login credential is required.",
      externalInput: {
        condition: "USER_INPUT_REQUIRED",
        cause: "No authorized credential reference matches the login.",
        effectState: "not_applied",
        authority: { required: true, type: "user", reason: "Only the user may provide it." },
        availableCapabilities: ["get_operating_context", "list_project_credentials",
          "create_project_credential", "authorize_environment_credentials", "resume_mission"],
        fulfillmentPaths: [
          { kind: "dashboard_managed", humanAction: "Add it in Project settings.",
            agentExposure: "none", result: "An opaque reference becomes discoverable.",
            availableCapabilities: ["get_operating_context", "list_project_credentials", "resume_mission"],
            dashboardPath: ["Project settings", "Test credentials", "Add credential"],
            continuation: sharedContinuation },
          { kind: "agent_assisted", humanAction: "Deliberately provide the plaintext to the agent.",
            agentExposure: "protected_plaintext_before_encrypted_storage",
            result: "Scry encrypts it and later use is by opaque reference.",
            availableCapabilities: ["create_project_credential", "authorize_environment_credentials",
              "resume_mission"], continuation: sharedContinuation },
        ],
        constraints: ["Do not guess or infer a credential."], consequences: [],
        continuation: { retryCurrentOperation: false, freshObservationRequired: true,
          newOperationRequired: true, newDraftRequired: false, newSessionRequired: false },
        waiting: true, terminal: false,
        lifecycle: { terminal: false, taskStillActive: true, sameMissionResumable: true,
          sameObjectiveResumable: true, shouldFinalize: false, shouldPublishFinalReport: false,
          shouldCreateReplacementMission: false,
          requiredNextStep: "fulfill_human_prerequisite_then_resume" },
        resumeRef: ids.objectiveId,
      },
    } as const;
    const parsed = missionResumePointerSchema.parse(pointer);
    expect(parsed.externalInput?.fulfillmentPaths.map(({ agentExposure }) => agentExposure))
      .toEqual(["none", "protected_plaintext_before_encrypted_storage"]);
    const dashboard = pointer.externalInput.fulfillmentPaths[0];
    const assisted = pointer.externalInput.fulfillmentPaths[1];
    expect(missionResumePointerSchema.safeParse({ ...pointer, externalInput: {
      ...pointer.externalInput, fulfillmentPaths: [{ ...dashboard,
        agentExposure: "protected_plaintext_before_encrypted_storage" }, assisted],
    } }).success).toBe(false);
    expect(missionResumePointerSchema.safeParse({ ...pointer, externalInput: {
      ...pointer.externalInput, fulfillmentPaths: [dashboard, { ...assisted,
        agentExposure: "none" }],
    } }).success).toBe(false);
    expect(missionResumePointerSchema.safeParse({ ...pointer, externalInput: {
      ...pointer.externalInput, fulfillmentPaths: [dashboard, { ...assisted,
        availableCapabilities: ["resume_mission"] }],
    } }).success).toBe(false);
    expect(missionResumePointerSchema.safeParse({ ...pointer, externalInput: {
      ...pointer.externalInput, fulfillmentPaths: [{ ...dashboard,
        dashboardPath: ["Account", "Approval queue"] }],
    } }).success).toBe(true);
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
