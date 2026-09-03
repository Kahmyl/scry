import { describe, expect, it, vi } from "vitest";

import { loadMissionReportCompositionReadiness } from "../src/missions/mission-report-readiness.js";
import { MissionService } from "../src/missions/mission.service.js";

const missionId = "11111111-1111-4111-8111-111111111111";
const objectiveId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const selectionId = "55555555-5555-4555-8555-555555555555";
const agentSessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "77777777-7777-4777-8777-777777777777";

function rows(items: Array<Record<string, unknown>> = []) {
  return { rowCount: items.length, rows: items };
}

async function readiness(
  query: ReturnType<typeof vi.fn>,
  missionRevision: number,
  artifactStore?: { exists(storageKey: string): Promise<boolean> },
) {
  const blockers: Array<Record<string, unknown>> = [];
  await loadMissionReportCompositionReadiness({
    query: query as never,
    missionId,
    missionRevision,
    ...(artifactStore ? { artifactStore: artifactStore as never } : {}),
    add: (blocker) => blockers.push(blocker),
  });
  return blockers;
}

describe("Mission report composition readiness", () => {
  it("blocks a recording selection made stale by later Mission changes", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM mission_recording_selections"))
        return rows([
          {
            id: selectionId,
            revision: 1,
            sourceMissionRevision: 3,
            selectedByAgentSessionId: agentSessionId,
            createdAt: "2026-08-23T16:00:00.000Z",
          },
        ]);
      if (text.includes("FROM mission_recording_selection_runs")) return rows();
      if (text.includes("count(*)::integer") && text.includes("FROM runs"))
        return rows([{ count: 0 }]);
      if (text.includes("FROM accepted_evidence")) return rows();
      return rows();
    });

    await expect(readiness(query, 5)).resolves.toEqual([
      expect.objectContaining({
        code: "MISSION_RECORDING_SELECTION_STALE",
        recordingId: selectionId,
        state: "stale",
      }),
    ]);
  });

  it("identifies a required evidence class omitted from the explicit selection", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM mission_recording_selections")) return rows();
      if (text.includes("count(*)::integer") && text.includes("FROM runs"))
        return rows([{ count: 0 }]);
      if (text.includes("FROM accepted_evidence"))
        return rows([
          {
            evidenceId: "88888888-8888-4888-8888-888888888888",
            objectiveId,
            runId,
            planSnapshot: { steps: [{ evidence: ["screenshot", { kind: "network" }] }] },
            artifactId,
            artifactKind: "screenshot",
            artifactAvailability: "available",
            artifactPrivacyClassification: "safe",
            destructionStatus: "pending",
            storageKey: "runs/screenshot.png",
          },
        ]);
      return rows();
    });

    await expect(readiness(query, 4)).resolves.toEqual([
      expect.objectContaining({
        code: "REPORT_REQUIRED_EVIDENCE_CLASS_MISSING",
        runId,
        evidenceClass: "network",
      }),
    ]);
  });

  it("distinguishes selected metadata unavailability from Artifact-store failure", async () => {
    const unavailableQuery = vi.fn(async (text: string) => {
      if (text.includes("FROM mission_recording_selections")) return rows();
      if (text.includes("count(*)::integer") && text.includes("FROM runs"))
        return rows([{ count: 0 }]);
      if (text.includes("FROM accepted_evidence"))
        return rows([
          {
            evidenceId: "88888888-8888-4888-8888-888888888888",
            objectiveId,
            runId,
            planSnapshot: { steps: [] },
            artifactId,
            artifactKind: "screenshot",
            artifactAvailability: "destroyed",
            artifactPrivacyClassification: "uncertain",
            destructionStatus: "deleted",
            storageKey: null,
          },
        ]);
      return rows();
    });
    const unavailableStore = { exists: vi.fn(async () => false) };
    await expect(readiness(unavailableQuery, 4, unavailableStore)).resolves.toEqual([
      expect.objectContaining({
        code: "REPORT_SELECTED_ARTIFACT_UNAVAILABLE",
        artifactId,
        state: "destroyed",
      }),
    ]);
    expect(unavailableStore.exists).not.toHaveBeenCalled();

    const storeQuery = vi.fn(async (text: string) => {
      if (text.includes("FROM mission_recording_selections")) return rows();
      if (text.includes("count(*)::integer") && text.includes("FROM runs"))
        return rows([{ count: 0 }]);
      if (text.includes("FROM accepted_evidence"))
        return rows([
          {
            evidenceId: "88888888-8888-4888-8888-888888888888",
            objectiveId,
            runId,
            planSnapshot: { steps: [] },
            artifactId,
            artifactKind: "screenshot",
            artifactAvailability: "available",
            artifactPrivacyClassification: "safe",
            destructionStatus: "pending",
            storageKey: "runs/screenshot.png",
          },
        ]);
      if (text.includes("FROM artifacts WHERE id=ANY"))
        return rows([{ artifactId, storageKey: "runs/screenshot.png" }]);
      return rows();
    });
    await expect(readiness(storeQuery, 4, { exists: vi.fn(async () => false) })).resolves.toEqual([
      expect.objectContaining({
        code: "REPORT_ARTIFACT_STORE_FAILURE",
        artifactId,
        state: "store_unavailable",
      }),
    ]);
  });

  it("reports an explicit unavailable recording interval without inventing media", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM mission_recording_selections"))
        return rows([
          {
            id: selectionId,
            revision: 1,
            sourceMissionRevision: 3,
            selectedByAgentSessionId: agentSessionId,
            createdAt: "2026-08-23T16:00:00.000Z",
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
            runCreatedAt: "2026-08-23T16:00:00.000Z",
            canonicalAttemptId: attemptId,
            canonicalAttemptRunId: runId,
            canonicalAttemptNumber: 1,
            canonicalAttemptState: "passed",
            canonicalAttemptStartedAt: "2026-08-23T16:00:00.000Z",
            canonicalAttemptCompletedAt: "2026-08-23T16:01:00.000Z",
          },
        ]);
      if (text.includes("FROM artifact_timeline_entries"))
        return rows([
          {
            attemptId,
            sequence: 0,
            entryType: "unavailable_interval",
            operationId: null,
            channel: "video",
            startedAt: "2026-08-23T16:00:10.000Z",
            endedAt: "2026-08-23T16:00:20.000Z",
            reasonCode: "BROWSER_LOST",
            metadata: {},
            contextId: null,
            captureEpoch: null,
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
        ]);
      if (text.includes("FROM accepted_evidence")) return rows();
      return rows();
    });

    await expect(readiness(query, 4)).resolves.toEqual([
      expect.objectContaining({
        code: "MISSION_RECORDING_GAP",
        runId,
        attemptId,
        reasonCode: "BROWSER_LOST",
      }),
    ]);
  });

  it("returns a typed null preview when report composition is stale", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([{ id: missionId, status: "running", revision: 5 }]);
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", revision: 5, finalReportId: null, resumePointer: null }]);
      if (text.includes("FROM mission_recording_selections"))
        return rows([
          {
            id: selectionId,
            revision: 1,
            sourceMissionRevision: 3,
            selectedByAgentSessionId: agentSessionId,
            createdAt: "2026-08-23T16:00:00.000Z",
          },
        ]);
      if (text.includes("FROM mission_recording_selection_runs")) return rows();
      if (text.includes("count(*)::integer") && text.includes("FROM runs"))
        return rows([{ count: 0 }]);
      return rows();
    });
    const database = { query };

    await expect(
      new MissionService(database as never).previewReport(
        { kind: "service", subject: "scry-service" },
        missionId,
      ),
    ).resolves.toMatchObject({
      snapshot: null,
      completionReadiness: {
        ready: false,
        blockers: [expect.objectContaining({ code: "MISSION_RECORDING_SELECTION_STALE" })],
      },
    });
  });
});
