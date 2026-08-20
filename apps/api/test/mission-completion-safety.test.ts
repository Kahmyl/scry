import { describe, expect, it, vi } from "vitest";

import { publishMissionReportSchema } from "@scry/contracts";

import { MissionService } from "../src/missions/mission.service.js";

const principal = {
  kind: "service",
  subject: "scry-service",
} as const;

const missionId = "11111111-1111-4111-8111-111111111111";
const objectiveId = "22222222-2222-4222-8222-222222222222";
const agentSessionId = "33333333-3333-4333-8333-333333333333";
const reportId = "44444444-4444-4444-8444-444444444444";

const publishInput = {
  missionId,
  agentSessionId,
  overallConclusion: "Mission complete.",
  journeySummary: ["Qualified terminal evidence."],
  remainingActions: [],
  expectedRevision: 4,
  idempotencyKey: "publish-final-report-1",
};

function rows(items: unknown[] = []) {
  return {
    rowCount: items.length,
    rows: items,
  };
}

function serviceFor(query: ReturnType<typeof vi.fn>) {
  return new MissionService({
    transaction: (
      work: (client: { query: typeof query }) => unknown,
    ) => work({ query }),
  } as never);
}

function publicationQuery(
  blocker:
    | "authoring"
    | "operation"
    | "run"
    | "attempt"
    | "orchestration",
) {
  let requestHash = "";

  return vi.fn(
    async (
      text: string,
      values: unknown[] = [],
    ) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([
          {
            id: missionId,
            projectId: "55555555-5555-4555-8555-555555555555",
            status: "running",
            revision: 4,
          },
        ]);

      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return rows();
      }

      if (
        text.includes('SELECT request_hash AS "requestHash"') &&
        text.includes("idempotency_records")
      )
        return rows([
          {
            requestHash,
            response: null,
          },
        ]);

      if (
        text.includes("FROM agent_sessions") &&
        text.includes("status='active'")
      )
        return rows([{}]);

      if (text.includes("FROM adaptive_sessions"))
        return blocker === "authoring" ? rows([{}]) : rows();

      if (text.includes("FROM adaptive_operations o"))
        return blocker === "operation" ? rows([{}]) : rows();

      if (
        text.includes("FROM runs") &&
        text.includes("state NOT IN")
      )
        return blocker === "run" ? rows([{}]) : rows();

      if (
        text.includes("FROM attempts a") &&
        text.includes("a.completed_at IS NULL")
      )
        return blocker === "attempt" ? rows([{}]) : rows();

      if (
        text.includes("FROM mission_objective_orchestration") &&
        text.includes("state NOT IN")
      )
        return blocker === "orchestration" ? rows([{}]) : rows();

      return rows();
    },
  );
}

describe("Mission completion safety", () => {
  it("requires an explicit idempotency key for final report publication", () => {
    const parsed = publishMissionReportSchema.safeParse({
      missionId,
      agentSessionId,
      overallConclusion: "Done",
      journeySummary: ["Done"],
      remainingActions: [],
      expectedRevision: 4,
    });

    expect(parsed.success).toBe(false);
  });

  it("does not let ordinary continuation silently enter a terminal Mission", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([
          {
            id: missionId,
            projectId: "55555555-5555-4555-8555-555555555555",
            status: "completed",
            revision: 9,
          },
        ]);

      return rows();
    });

    const service = serviceFor(query);

    await expect(
      service.startSession(principal, missionId, {
        provider: "codex",
        instructionSnapshot: "Continue the completed Mission.",
        idempotencyKey: "terminal-mission-resume",
        continuationAuthority: {
          confirmedUserAuthorized: true,
          selection: "continue_existing_mission",
          source: "current_request_explicit",
        },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_REOPEN_REQUIRED",
      }),
    });

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("INSERT INTO agent_sessions"),
      ),
    ).toBe(false);
  });

  it.each([
    ["authoring", "MISSION_RUNTIME_CLOSE_REQUIRED"],
    ["operation", "MISSION_RUNTIME_RECONCILIATION_REQUIRED"],
    ["run", "MISSION_RUNS_NOT_TERMINAL"],
    ["attempt", "MISSION_ATTEMPTS_NOT_TERMINAL"],
    ["orchestration", "MISSION_ORCHESTRATION_NOT_TERMINAL"],
  ] as const)(
    "refuses final report publication while %s work remains",
    async (blocker, code) => {
      const query = publicationQuery(blocker);
      const service = serviceFor(query);

      await expect(
        service.publishReport(
          principal,
          missionId,
          publishInput,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code,
        }),
      });

      expect(
        query.mock.calls.some(([text]) =>
          String(text).includes(
            "UPDATE missions SET status='completed'",
          ),
        ),
      ).toBe(false);
    },
  );

  it("replays an already committed final report before terminal/session checks", async () => {
    let requestHash = "";

    const committed = {
      id: reportId,
      missionId,
      revision: 1,
      status: "published",
      snapshot: {
        mission: {
          status: "completed",
        },
      },
      replayed: false,
    };

    const query = vi.fn(
      async (
        text: string,
        values: unknown[] = [],
      ) => {
        if (text.includes("FROM missions m JOIN projects"))
          return rows([
            {
              id: missionId,
              projectId: "55555555-5555-4555-8555-555555555555",
              status: "completed",
              revision: 5,
            },
          ]);

        if (text.includes("INSERT INTO idempotency_records")) {
          requestHash = String(values[2]);
          return rows();
        }

        if (
          text.includes('SELECT request_hash AS "requestHash"') &&
          text.includes("idempotency_records")
        )
          return rows([
            {
              requestHash,
              response: committed,
            },
          ]);

        return rows();
      },
    );

    const service = serviceFor(query);

    await expect(
      service.publishReport(
        principal,
        missionId,
        publishInput,
      ),
    ).resolves.toMatchObject({
      id: reportId,
      missionId,
      status: "published",
      replayed: true,
    });

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("FROM agent_sessions"),
      ),
    ).toBe(false);

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes(
          "UPDATE missions SET status='completed'",
        ),
      ),
    ).toBe(false);
  });
});
