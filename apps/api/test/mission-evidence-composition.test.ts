import { describe, expect, it, vi } from "vitest";

import { MissionService } from "../src/missions/mission.service.js";

type QueryStub = (
  text: string,
  values?: unknown[],
) => Promise<{
  rowCount: number;
  rows: unknown[];
}>;

const principal = {
  kind: "service",
  subject: "scry-service",
} as const;

const missionId = "11111111-1111-4111-8111-111111111111";
const objectiveId = "22222222-2222-4222-8222-222222222222";
const agentSessionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const canonicalAttemptId = "55555555-5555-4555-8555-555555555555";
const artifactId = "66666666-6666-4666-8666-666666666666";
const secondArtifactId = "67676767-6767-4767-8767-676767676767";

function rows(items: unknown[] = []) {
  return {
    rowCount: items.length,
    rows: items,
  };
}

describe("Mission evidence composition", () => {
  it("freezes accepted Run/Attempt/Artifact provenance into the report snapshot", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (
        text.includes('original_instruction AS "originalInstruction"') &&
        text.includes("FROM missions")
      )
        return rows([
          {
            id: missionId,
            revision: 11,
            title: "Mission",
            originalInstruction: "Test Mission evidence.",
            status: "running",
          },
        ]);

      if (
        text.includes("FROM mission_objectives o") &&
        text.includes('o.objective_order AS "order"')
      )
        return rows([
          {
            id: objectiveId,
            title: "Objective",
            status: "passed",
            conclusion: "Objective conclusion",
            order: 0,
          },
        ]);

      if (text.includes("FROM accepted_evidence e") && text.includes("JOIN LATERAL"))
        return rows([
          {
            id: "77777777-7777-4777-8777-777777777777",
            objectiveId,
            runId,
            artifactId,
            acceptanceConclusion: "Accepted by external agent.",
            acceptedByAgentSessionId: agentSessionId,
            acceptedAt: "2026-08-16 22:34:04+00",
            runState: "passed",
            runOutcomeClassification: "application_pass",
            runResultClassification: "passed",
            runReliabilityEligible: true,
            runFlowRevisionId: "88888888-8888-4888-8888-888888888888",
            runEnvironmentId: "99999999-9999-4999-8999-999999999999",
            runExecutionModel: "agent_directed_v1",
            runCreatedAt: "2026-08-16 22:33:49+00",
            runUpdatedAt: "2026-08-16 22:34:03+00",
            canonicalAttemptId,
            canonicalAttemptRunId: runId,
            canonicalAttemptNumber: 1,
            canonicalAttemptState: "passed",
            canonicalAttemptStartedAt: "2026-08-16 22:33:49+00",
            canonicalAttemptCompletedAt: "2026-08-16 22:34:03+00",
            artifactAttemptId: canonicalAttemptId,
            artifactStepId: "step-1",
            artifactKind: "screenshot",
            artifactAvailability: "available",
            artifactPrivacyClassification: "safe",
            artifactContentType: "image/png",
            artifactSizeBytes: "4257",
            artifactChecksumSha256: "a".repeat(64),
            artifactContextId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            artifactCaptureEpoch: 1,
            artifactRetentionUntil: "2026-09-15 22:34:03+00",
            artifactCreatedAt: "2026-08-16 22:34:01+00",
          },
        ]);

      if (
        text.includes("FROM attempts a") &&
        text.includes("FROM attempts newer") &&
        text.includes("newer.attempt_number")
      )
        return rows([{ count: 2 }]);

      if (text.includes("FROM mission_recording_selections"))
        return rows([
          {
            id: "abababab-abab-4bab-8bab-abababababab",
            revision: 1,
            sourceMissionRevision: 11,
            selectedByAgentSessionId: agentSessionId,
            createdAt: "2026-08-16 22:34:05+00",
          },
        ]);

      if (text.includes("FROM mission_recording_selection_runs"))
        return rows([
          {
            runOrder: 0,

            runId,
            objectiveId,

            runState: "passed",
            runOutcomeClassification: "passed",
            runResultClassification: "application_pass",

            runCreatedAt: "2026-08-16 22:33:49+00",

            canonicalAttemptId,
            canonicalAttemptRunId: runId,
            canonicalAttemptNumber: 1,
            canonicalAttemptState: "passed",
            canonicalAttemptStartedAt: "2026-08-16 22:33:49+00",
            canonicalAttemptCompletedAt: "2026-08-16 22:34:03+00",
          },
        ]);

      if (text.includes("FROM artifact_timeline_entries")) return rows([]);

      throw new Error(`UNEXPECTED_QUERY: ${text}`);
    });

    const protectedOperations = {
      listMutationReceiptsForRuns: vi.fn(async () => []),
    };
    const service = new MissionService({} as never, undefined, protectedOperations as never);

    const snapshot = await (
      service as unknown as {
        buildReportSnapshot(
          query: QueryStub,
          missionId: string,
          overallConclusion: string,
          journeySummary: string[],
          remainingActions: string[],
          finalStatus?: string,
        ): Promise<{
          mission: { status: string };
          evidenceDigest: string;
          evidence: {
            schemaVersion: number;
            sourceMissionRevision: number;
            objectives: Array<{
              acceptedRunIds: string[];
              acceptedArtifactIds: string[];
              acceptedEvidence: Array<{
                canonicalAttempt: {
                  id: string;
                };
                artifact: {
                  checksumSha256: string;
                } | null;
              }>;
            }>;
          };
          objectiveResults: Array<{
            acceptedRunIds: string[];
            acceptedArtifactIds: string[];
          }>;
          supersededAttemptCount: number;
          mutationReceipts: unknown[];
          compositionDigest: string;
        }>;
      }
    ).buildReportSnapshot(query, missionId, "Agent conclusion", ["Journey"], [], "completed");

    expect(snapshot.mission.status).toBe("completed");

    expect(snapshot.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(snapshot.evidence.sourceMissionRevision).toBe(11);

    expect(snapshot.evidence.objectives[0]!.acceptedRunIds).toEqual([runId]);

    expect(snapshot.evidence.objectives[0]!.acceptedArtifactIds).toEqual([artifactId]);

    expect(snapshot.evidence.objectives[0]!.acceptedEvidence[0]!.canonicalAttempt.id).toBe(
      canonicalAttemptId,
    );

    expect(snapshot.evidence.objectives[0]!.acceptedEvidence[0]!.artifact!.checksumSha256).toBe(
      "a".repeat(64),
    );

    expect(snapshot.objectiveResults[0]!.acceptedRunIds).toEqual([runId]);

    expect(snapshot.supersededAttemptCount).toBe(2);
    expect(snapshot.mutationReceipts).toEqual([]);
    expect(snapshot.compositionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(protectedOperations.listMutationReceiptsForRuns).toHaveBeenCalledWith([runId]);
  });

  it("refuses an Artifact from a non-canonical Attempt", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: missionId,
            projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "running",
            revision: 11,
          },
        ]);

      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);

      if (text.includes("SELECT 1 FROM mission_objectives")) return rows([{}]);

      if (text.includes("SELECT id,state FROM runs"))
        return rows([
          {
            id: runId,
            state: "passed",
          },
        ]);

      if (text.includes("FROM attempts") && text.includes("ORDER BY attempt_number DESC"))
        return rows([
          {
            id: canonicalAttemptId,
            state: "passed",
          },
        ]);

      if (text.includes("FROM artifacts") && text.includes("attempt_id=$1")) return rows([]);

      throw new Error(`UNEXPECTED_QUERY: ${text}`);
    });

    const service = new MissionService({
      transaction: (work: (client: { query: QueryStub }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.acceptEvidence(principal, objectiveId, {
        missionId,
        agentSessionId,
        runId,
        artifactIds: [artifactId],
        conclusion: "Attempt to accept stale Artifact.",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "EVIDENCE_NOT_ADMISSIBLE",
      }),
    });

    expect(
      query.mock.calls.some(([text]) => String(text).includes("INSERT INTO accepted_evidence")),
    ).toBe(false);
  });

  it("supersedes the previous selection and preserves the caller's exact Artifact order", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: missionId,
            projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            status: "running",
            revision: 11,
          },
        ]);
      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);
      if (text.includes("SELECT 1 FROM mission_objectives")) return rows([{}]);
      if (text.includes("SELECT id,state FROM runs")) return rows([{ id: runId, state: "passed" }]);
      if (text.includes("FROM attempts") && text.includes("ORDER BY attempt_number DESC"))
        return rows([{ id: canonicalAttemptId, state: "passed" }]);
      if (text.includes("FROM artifacts") && text.includes("attempt_id=$1"))
        return rows([{ id: artifactId }, { id: secondArtifactId }]);
      if (text.includes("FROM credential_incidents")) return rows();
      return rows();
    });
    const service = new MissionService({
      transaction: (work: (client: { query: QueryStub }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.acceptEvidence(principal, objectiveId, {
        missionId,
        agentSessionId,
        runId,
        artifactIds: [secondArtifactId, artifactId],
        conclusion: "Accept the explicitly ordered evidence selection.",
      }),
    ).resolves.toEqual({ objectiveId, runId, status: "accepted" });

    const supersedeIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("UPDATE accepted_evidence SET superseded_at=now()"),
    );
    const inserts = query.mock.calls.filter(([text]) =>
      String(text).includes("INSERT INTO accepted_evidence"),
    );
    expect(supersedeIndex).toBeGreaterThan(-1);
    expect(query.mock.calls.indexOf(inserts[0]!)).toBeGreaterThan(supersedeIndex);
    expect(inserts.map(([, values]) => values?.[3])).toEqual([secondArtifactId, artifactId]);

    const activity = query.mock.calls.find(([text]) =>
      String(text).includes("INSERT INTO mission_activities"),
    );
    expect(JSON.parse(String(activity?.[1]?.[5]))).toMatchObject({
      orderedArtifactIds: [secondArtifactId, artifactId],
    });
  });
});
