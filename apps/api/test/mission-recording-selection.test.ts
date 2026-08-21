import { createHash } from "node:crypto";

import { setMissionRecordingSelectionSchema } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { MissionService } from "../src/missions/mission.service.js";

type QueryResult = {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

const rows = (values: Array<Record<string, unknown>> = []): QueryResult => ({
  rowCount: values.length,
  rows: values,
});

describe("Mission recording selection authority", () => {
  it("rejects duplicate Run authority at the public contract", () => {
    const runId = "11111111-1111-4111-8111-111111111111";

    expect(
      setMissionRecordingSelectionSchema.safeParse({
        missionId: "22222222-2222-4222-8222-222222222222",
        agentSessionId: "33333333-3333-4333-8333-333333333333",
        expectedMissionRevision: 11,
        orderedRunIds: [runId, runId],
        idempotencyKey: "recording-selection-test",
      }).success,
    ).toBe(false);
  });

  it("persists caller order exactly, supersedes old authority, increments Mission revision, and audits", async () => {
    const missionId = "22222222-2222-4222-8222-222222222222";

    const sessionId = "33333333-3333-4333-8333-333333333333";

    const runA = "44444444-4444-4444-8444-444444444444";

    const runB = "55555555-5555-4555-8555-555555555555";

    const objectiveA = "66666666-6666-4666-8666-666666666666";

    const objectiveB = "77777777-7777-4777-8777-777777777777";

    let requestHash = "";

    const query = vi.fn(async (text: string, values: unknown[] = []): Promise<QueryResult> => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: missionId,
            projectId: "88888888-8888-4888-8888-888888888888",
            status: "running",
            revision: 11,
          },
        ]);

      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);

      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = createHash("sha256")
          .update(
            JSON.stringify({
              missionId,
              agentSessionId: sessionId,
              expectedMissionRevision: 11,
              orderedRunIds: [runB, runA],
              idempotencyKey: "recording-selection-test",
            }),
          )
          .digest("hex");

        return rows();
      }

      if (text.includes('SELECT request_hash AS "requestHash",response'))
        return rows([
          {
            requestHash,
            response: null,
          },
        ]);

      if (text.includes('objective_id AS "objectiveId"') && text.includes("FROM runs"))
        return rows([
          {
            id: runA,
            objectiveId: objectiveA,
          },
          {
            id: runB,
            objectiveId: objectiveB,
          },
        ]);

      if (
        text.includes("FROM mission_recording_selections") &&
        text.includes("ORDER BY revision DESC")
      )
        return rows();

      if (text.includes("UPDATE mission_recording_selections")) return rows();

      if (text.includes("INSERT INTO mission_recording_selections")) return rows();

      if (text.includes("INSERT INTO mission_recording_selection_runs")) return rows();

      if (text.includes("UPDATE missions") && text.includes("RETURNING revision"))
        return rows([
          {
            revision: 12,
          },
        ]);

      if (text.includes("INSERT INTO mission_activities"))
        return rows([
          {
            id: "99999999-9999-4999-8999-999999999999",
          },
        ]);

      if (text.includes("UPDATE idempotency_records")) return rows();

      throw new Error(`UNEXPECTED_QUERY: ${text} :: ${JSON.stringify(values)}`);
    });

    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    const result = await service.setRecordingSelection(
      {
        kind: "service",
        subject: "scry-service",
      },
      missionId,
      {
        missionId,
        agentSessionId: sessionId,
        expectedMissionRevision: 11,
        orderedRunIds: [runB, runA],
        idempotencyKey: "recording-selection-test",
      },
    );

    expect(result).toMatchObject({
      missionId,
      selectionRevision: 1,
      sourceMissionRevision: 11,
      orderedRunIds: [runB, runA],
      missionRevision: 12,
      replayed: false,
    });

    const membershipWrites = query.mock.calls.filter(([text]) =>
      String(text).includes("INSERT INTO mission_recording_selection_runs"),
    );

    expect(membershipWrites).toHaveLength(2);

    expect(membershipWrites[0]![1]).toEqual(
      expect.arrayContaining([missionId, objectiveB, runB, 0]),
    );

    expect(membershipWrites[1]![1]).toEqual(
      expect.arrayContaining([missionId, objectiveA, runA, 1]),
    );

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("UPDATE mission_recording_selections"),
      ),
    ).toBe(true);

    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes("INSERT INTO mission_activities") &&
          Array.isArray(values) &&
          values.includes("recording_selection_updated"),
      ),
    ).toBe(true);
  });

  it("refuses an empty selection once a Mission has browser Runs", async () => {
    const missionId = "22222222-2222-4222-8222-222222222222";

    const sessionId = "33333333-3333-4333-8333-333333333333";

    let requestHash = "";

    const input = {
      missionId,
      agentSessionId: sessionId,
      expectedMissionRevision: 11,
      orderedRunIds: [],
      idempotencyKey: "empty-recording-selection-test",
    };

    const query = vi.fn(async (text: string): Promise<QueryResult> => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: missionId,
            projectId: "88888888-8888-4888-8888-888888888888",
            status: "running",
            revision: 11,
          },
        ]);

      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);

      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

        return rows();
      }

      if (text.includes('SELECT request_hash AS "requestHash",response'))
        return rows([
          {
            requestHash,
            response: null,
          },
        ]);

      if (text.includes("SELECT 1") && text.includes("FROM runs")) return rows([{}]);

      throw new Error(`UNEXPECTED_QUERY: ${text}`);
    });

    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.setRecordingSelection(
        {
          kind: "service",
          subject: "scry-service",
        },
        missionId,
        input,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECORDING_SELECTION_EMPTY_WITH_RUNS",
      }),
    });

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("INSERT INTO mission_recording_selections"),
      ),
    ).toBe(false);
  });
});
