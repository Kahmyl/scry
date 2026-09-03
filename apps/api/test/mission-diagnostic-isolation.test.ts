import { describe, expect, it, vi } from "vitest";

import { MissionService } from "../src/missions/mission.service.js";

const id = {
  project: "11111111-1111-4111-8111-111111111111",
  otherProject: "22222222-2222-4222-8222-222222222222",
  sourceMission: "33333333-3333-4333-8333-333333333333",
  targetMission: "44444444-4444-4444-8444-444444444444",
  agentSession: "55555555-5555-4555-8555-555555555555",
  relation: "66666666-6666-4666-8666-666666666666",
};

const principal = { kind: "service", subject: "scry-service" } as const;

function rows(items: Array<Record<string, unknown>> = []) {
  return { rowCount: items.length, rows: items };
}

function input() {
  return {
    missionId: id.sourceMission,
    agentSessionId: id.agentSession,
    targetMissionId: id.targetMission,
    relation: "diagnoses" as const,
    reason: "The isolated diagnostic Mission informs the primary successor.",
    idempotencyKey: "diagnostic-relation-0001",
  };
}

describe("diagnostic and primary Mission isolation", () => {
  it("appends same-Project provenance without touching protected-operation ownership", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: values[0],
            projectId: id.project,
            status: "running",
            revision: 2,
          },
        ]);
      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return rows();
      }
      if (text.includes('SELECT request_hash AS "requestHash"'))
        return rows([{ requestHash, response: null }]);
      if (text.includes("INSERT INTO mission_relations"))
        return rows([{ createdAt: "2026-08-23T17:00:00.000Z" }]);
      if (text.includes("INSERT INTO mission_activities")) return rows([{ id: id.relation }]);
      return rows();
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.relateMissions(principal, id.sourceMission, input()),
    ).resolves.toMatchObject({
      projectId: id.project,
      sourceMissionId: id.sourceMission,
      targetMissionId: id.targetMission,
      relation: "diagnoses",
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text]) => /(?:UPDATE|INSERT INTO) protected_operations/i.test(text)),
    ).toBe(false);
    expect(
      query.mock.calls.find(([text]) =>
        String(text).includes("INSERT INTO mission_relations"),
      )?.[1],
    ).toEqual([
      expect.any(String),
      id.project,
      id.sourceMission,
      id.targetMission,
      "diagnoses",
      id.agentSession,
      input().reason,
    ]);
  });

  it("rejects a cross-Project relation before provenance is inserted", async () => {
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM missions m JOIN projects p"))
        return rows([
          {
            id: values[0],
            projectId: values[0] === id.sourceMission ? id.project : id.otherProject,
            status: "running",
            revision: 2,
          },
        ]);
      if (text.includes("SELECT 1 FROM agent_sessions")) return rows([{}]);
      return rows();
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.relateMissions(principal, id.sourceMission, input()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MISSION_RELATION_PROJECT_MISMATCH" }),
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes("INSERT INTO mission_relations")),
    ).toBe(false);
  });
});
