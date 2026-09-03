import { describe, expect, it, vi } from "vitest";
import { projectMutationReceipt } from "@scry/contracts";

import { MissionService } from "../src/missions/mission.service.js";

const id = {
  project: "11111111-1111-4111-8111-111111111111",
  mission: "22222222-2222-4222-8222-222222222222",
  objective: "33333333-3333-4333-8333-333333333333",
  agent: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  attempt: "66666666-6666-4666-8666-666666666666",
  selection: "77777777-7777-4777-8777-777777777777",
  videoA: "88888888-8888-4888-8888-888888888888",
  videoB: "99999999-9999-4999-8999-999999999999",
  trace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  screenshot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  network: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  flowRevision: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  environment: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  context: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  diagnosticMission: "10101010-1010-4010-8010-101010101010",
  relation: "11111111-2222-4111-8111-111111111111",
  unknownOperation: "12121212-3434-4212-8212-121212121212",
};

const selectedRun = {
  runOrder: 0,
  runId: id.run,
  objectiveId: id.objective,
  runState: "passed",
  runOutcomeClassification: "passed",
  runResultClassification: "application_pass",
  runCreatedAt: "2026-08-23T16:00:00.000Z",
  canonicalAttemptId: id.attempt,
  canonicalAttemptRunId: id.run,
  canonicalAttemptNumber: 1,
  canonicalAttemptState: "passed",
  canonicalAttemptStartedAt: "2026-08-23T16:00:00.000Z",
  canonicalAttemptCompletedAt: "2026-08-23T16:04:00.000Z",
};

const timeline = [
  timelineArtifact(0, "video_segment", id.videoA, "video", "video/webm"),
  {
    attemptId: id.attempt,
    sequence: 1,
    entryType: "protected_gap",
    operationId: "protected-login",
    channel: null,
    startedAt: "2026-08-23T16:01:00.000Z",
    endedAt: "2026-08-23T16:01:10.000Z",
    reasonCode: "PROTECTED_CAPTURE_SUPPRESSED",
    metadata: { reason: "protected_operation", privacyStatus: "capture_suppressed" },
    contextId: id.context,
    captureEpoch: 1,
    artifactId: null,
    artifactAttemptId: null,
    artifactKind: null,
    artifactAvailability: null,
    artifactPrivacyClassification: null,
    artifactContentType: null,
    artifactSizeBytes: null,
    artifactChecksumSha256: null,
    artifactContextId: null,
    artifactCaptureEpoch: null,
    artifactCreatedAt: null,
  },
  timelineArtifact(2, "video_segment", id.videoB, "video", "video/webm"),
  timelineArtifact(3, "trace_segment", id.trace, "trace", "application/zip"),
];

const accepted = [
  acceptedArtifact(id.screenshot, "screenshot", "image/png", 0, "step-screenshot"),
  acceptedArtifact(id.network, "network", "application/json", 1, "step-network"),
  acceptedArtifact(id.trace, "trace", "application/zip", 2, "step-trace"),
];

describe("production-shaped Mission report composition", () => {
  it("publishes and reads back the exact immutable multi-segment selection", async () => {
    let requestHash = "";
    let persistedSnapshot: Record<string, unknown> | null = null;
    let persistedReportId = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([{ id: id.mission, projectId: id.project, status: "running", revision: 8 }]);
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return rows();
      }
      if (text.includes('SELECT request_hash AS "requestHash"'))
        return rows([{ requestHash, response: null }]);
      if (
        text.includes('original_instruction AS "originalInstruction"') &&
        !text.includes("JOIN projects")
      )
        return rows([
          {
            id: id.mission,
            revision: 8,
            title: "Composed Mission",
            originalInstruction: "Verify the complete protected journey.",
            purpose: "primary",
            status: "running",
          },
        ]);
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", revision: 8, finalReportId: null, resumePointer: null }]);
      if (text.includes("FROM mission_relations relation"))
        return rows([
          {
            relationId: id.relation,
            relation: "diagnoses",
            direction: "incoming",
            reason: "Isolated diagnostic provenance remains disclosed.",
            createdAt: "2026-08-23T15:00:00.000Z",
            relatedMissionId: id.diagnosticMission,
            relatedMissionPurpose: "diagnostic",
            relatedMissionStatus: "blocked",
          },
        ]);
      if (text.includes("mission_id=ANY($1::uuid[])"))
        return rows([
          {
            protectedOperationId: id.unknownOperation,
            missionId: id.diagnosticMission,
            operationId: "diagnostic-probe",
            objectiveId: "13131313-3434-4313-8313-131313131313",
            state: "recovery_required",
            mutationOutcome: "unknown",
            recoveryClass: "reconciliation_required",
            failureCode: "PROVIDER_RESULT_UNKNOWN",
            updatedAt: "2026-08-23T15:04:00.000Z",
          },
        ]);
      if (text.includes("FROM protected_operations")) return rows();
      if (text.includes("FROM adaptive_operations o")) return rows();
      if (text.includes("FROM adaptive_sessions")) return rows();
      if (text.includes("FROM runs WHERE mission_id") && text.includes("state NOT IN"))
        return rows();
      if (text.includes("FROM attempts a") && text.includes("a.completed_at IS NULL"))
        return rows();
      if (text.includes("FROM mission_objective_orchestration x")) return rows();
      if (text.includes("SELECT id,status FROM mission_objectives")) return rows();
      if (text.includes("FROM credential_incidents ci")) return rows();
      if (text.includes("FROM mission_recording_selections"))
        return rows([
          {
            id: id.selection,
            revision: 1,
            sourceMissionRevision: 7,
            selectedByAgentSessionId: id.agent,
            createdAt: "2026-08-23T16:05:00.000Z",
            sources: [{ order: 0, runId: id.run, canonicalAttemptId: id.attempt }],
          },
        ]);
      if (text.includes("FROM mission_recording_selection_runs")) return rows([selectedRun]);
      if (text.includes("FROM artifact_timeline_entries")) return rows(timeline);
      if (text.includes('r.plan_snapshot AS "planSnapshot"'))
        return rows(
          accepted.map((artifact) => ({
            evidenceId: artifact.id,
            objectiveId: id.objective,
            runId: id.run,
            planSnapshot: {
              steps: [{ evidence: ["screenshot", "network", "trace"] }],
            },
            artifactId: artifact.artifactId,
            artifactKind: artifact.artifactKind,
            artifactAvailability: "available",
            artifactPrivacyClassification: "safe",
            destructionStatus: "pending",
            storageKey: `mission/${artifact.artifactId}`,
          })),
        );
      if (text.includes("FROM artifacts WHERE id=ANY"))
        return rows(
          [id.videoA, id.videoB, id.trace, id.screenshot, id.network].map((artifactId) => ({
            artifactId,
            storageKey: `mission/${artifactId}`,
          })),
        );
      if (text.includes("FROM agent_sessions") && text.includes("status='active'"))
        return rows([{}]);
      if (text.includes("FROM mission_objectives o") && text.includes('AS "order"'))
        return rows([
          {
            id: id.objective,
            title: "Complete journey",
            status: "passed",
            conclusion: "All selected evidence passed.",
            order: 0,
          },
        ]);
      if (text.includes("FROM accepted_evidence e") && text.includes("JOIN LATERAL"))
        return rows(accepted);
      if (text.includes("FROM attempts a") && text.includes("FROM attempts newer"))
        return rows([{ count: 1 }]);
      if (text.includes("SELECT revision FROM mission_reports")) return rows();
      if (text.includes("INSERT INTO mission_reports")) {
        persistedReportId = String(values[0]);
        persistedSnapshot = JSON.parse(String(values[3])) as Record<string, unknown>;
        return rows();
      }
      if (text.includes("INSERT INTO mission_activities"))
        return rows([{ id: "12121212-1212-4212-8212-121212121212" }]);
      if (text.includes("FROM mission_reports r JOIN missions m"))
        return rows([
          {
            id: persistedReportId,
            missionId: id.mission,
            revision: 1,
            status: "published",
            snapshot: persistedSnapshot,
            createdAt: "2026-08-23T16:06:00.000Z",
          },
        ]);
      return rows();
    });
    const database = {
      query,
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    };
    const store = { exists: vi.fn(async () => true) };
    const receipt = projectMutationReceipt({
      receiptId: "13131313-1313-4313-8313-131313131313",
      operationId: "protected-login",
      ownerKind: "run",
      ownerId: id.run,
      projectId: id.project,
      environmentId: id.environment,
      missionId: id.mission,
      objectiveId: id.objective,
      agentSessionId: id.agent,
      runId: id.run,
      dispatchSemantics: "mutation",
      programDigest: "a".repeat(64),
      syntheticInputSetCommitment: "b".repeat(64),
      payloadCommitment: "c".repeat(64),
      providerIdempotencyCommitment: "d".repeat(64),
      state: "completed",
      dispatchState: "acknowledged",
      mutationOutcome: "applied",
      persistenceState: "committed",
      persistedReferences: {},
      failureCode: null,
      transitions: [
        {
          sequence: 1,
          fromState: null,
          toState: "completed",
          phase: "reconciliation",
          reasonCode: null,
          safeDiagnostics: { reconciliation: "succeeded" },
          occurredAt: "2026-08-23T16:03:30.000Z",
        },
      ],
      responseIdentities: [
        {
          bindingId: "14141414-1414-4414-8414-141414141414",
          publicValueId: "15151515-1515-4515-8515-151515151515",
          provider: "test-provider",
          resourceKind: "session",
          resourceScope: "sandbox",
          identityContractVersion: 1,
          identitySource: "response",
          lifecycleState: "active",
        },
      ],
    });
    const protectedOperations = {
      listMutationReceiptsForRuns: vi.fn(async () => [receipt]),
    };
    const service = new MissionService(
      database as never,
      store as never,
      protectedOperations as never,
    );
    const published = await service.publishReport(
      { kind: "service", subject: "scry-service" },
      id.mission,
      {
        missionId: id.mission,
        agentSessionId: id.agent,
        overallConclusion: "The complete journey passed.",
        journeySummary: ["Captured, protected, resumed, and verified."],
        remainingActions: [],
        expectedRevision: 8,
        idempotencyKey: "production-shaped-report-journey",
      },
    );

    expect(published.snapshot.objectiveResults[0]!.acceptedArtifactIds).toEqual([
      id.screenshot,
      id.network,
      id.trace,
    ]);
    expect(
      published.snapshot.recording?.runs[0]!.timeline.map(({ entryType }) => entryType),
    ).toEqual(["video_segment", "protected_gap", "video_segment", "trace_segment"]);
    expect(published.snapshot.recording?.runs[0]!.timeline[1]!.artifact).toBeNull();
    expect(published.snapshot.recording?.runs[0]!.timeline[1]!.reason).toBe("protected_operation");
    expect(published.snapshot.compositionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(published.snapshot.relatedMissions).toEqual([
      expect.objectContaining({
        relation: "diagnoses",
        direction: "incoming",
        relatedMission: expect.objectContaining({
          id: id.diagnosticMission,
          purpose: "diagnostic",
          status: "blocked",
        }),
        unresolvedProtectedOperations: [
          expect.objectContaining({
            protectedOperationId: id.unknownOperation,
            mutationOutcome: "unknown",
            recoveryClass: "reconciliation_required",
          }),
        ],
      }),
    ]);
    expect(published.snapshot.mutationReceipts).toEqual([
      expect.objectContaining({
        mutationOutcome: "applied",
        reconciliation: expect.objectContaining({ state: "proven_applied" }),
        responseIdentities: [
          expect.objectContaining({
            provider: "test-provider",
            resourceKind: "session",
            provenance: "response",
          }),
        ],
      }),
    ]);
    expect(protectedOperations.listMutationReceiptsForRuns).toHaveBeenCalledWith([id.run]);
    expect(store.exists).toHaveBeenCalledTimes(5);

    const readback = await service.getReport(
      { kind: "service", subject: "scry-service" },
      published.id,
    );
    expect(readback?.snapshot).toEqual(published.snapshot);
    expect(persistedSnapshot).toEqual(published.snapshot);
  });
});

function rows(items: Array<Record<string, unknown>> = []) {
  return { rowCount: items.length, rows: items };
}

function timelineArtifact(
  sequence: number,
  entryType: "video_segment" | "trace_segment",
  artifactId: string,
  kind: string,
  contentType: string,
) {
  return {
    attemptId: id.attempt,
    sequence,
    entryType,
    operationId: null,
    channel: kind,
    startedAt: `2026-08-23T16:0${sequence}:00.000Z`,
    endedAt: `2026-08-23T16:0${sequence}:30.000Z`,
    reasonCode: null,
    metadata: { reason: sequence === 0 ? "run_started" : "safe_resume", status: "available" },
    contextId: id.context,
    captureEpoch: 1,
    artifactId,
    artifactAttemptId: id.attempt,
    artifactKind: kind,
    artifactAvailability: "available",
    artifactPrivacyClassification: "safe",
    artifactContentType: contentType,
    artifactSizeBytes: "1000",
    artifactChecksumSha256: `${sequence + 1}`.repeat(64),
    artifactContextId: id.context,
    artifactCaptureEpoch: 1,
    artifactCreatedAt: `2026-08-23T16:0${sequence}:31.000Z`,
  };
}

function acceptedArtifact(
  artifactId: string,
  kind: string,
  contentType: string,
  selectionOrder: number,
  stepId: string,
) {
  return {
    id: `0${selectionOrder + 1}010101-0101-4101-8101-010101010101`,
    objectiveId: id.objective,
    runId: id.run,
    artifactId,
    selectionOrder,
    acceptanceConclusion: "Accepted by the external agent.",
    acceptedByAgentSessionId: id.agent,
    acceptedAt: `2026-08-23T16:04:0${selectionOrder}.000Z`,
    runState: "passed",
    runOutcomeClassification: "passed",
    runResultClassification: "application_pass",
    runReliabilityEligible: true,
    runFlowRevisionId: id.flowRevision,
    runEnvironmentId: id.environment,
    runExecutionModel: "agent_directed_v1",
    runCreatedAt: "2026-08-23T16:00:00.000Z",
    runUpdatedAt: "2026-08-23T16:04:00.000Z",
    canonicalAttemptId: id.attempt,
    canonicalAttemptRunId: id.run,
    canonicalAttemptNumber: 1,
    canonicalAttemptState: "passed",
    canonicalAttemptStartedAt: "2026-08-23T16:00:00.000Z",
    canonicalAttemptCompletedAt: "2026-08-23T16:04:00.000Z",
    artifactAttemptId: id.attempt,
    artifactStepId: stepId,
    artifactKind: kind,
    artifactAvailability: "available",
    artifactPrivacyClassification: "safe",
    artifactContentType: contentType,
    artifactSizeBytes: "1000",
    artifactChecksumSha256: `${selectionOrder + 4}`.repeat(64),
    artifactContextId: id.context,
    artifactCaptureEpoch: 1,
    artifactRetentionUntil: "2026-09-23T16:04:00.000Z",
    artifactCreatedAt: `2026-08-23T16:03:0${selectionOrder}.000Z`,
  };
}
