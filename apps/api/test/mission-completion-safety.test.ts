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
    transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
  } as never);
}

function publicationQuery(
  blocker: "authoring" | "operation" | "run" | "attempt" | "orchestration",
) {
  let requestHash = "";

  return vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("FROM missions m JOIN projects"))
      return rows([
        {
          id: missionId,
          projectId: "55555555-5555-4555-8555-555555555555",
          status: "running",
          revision: 4,
        },
      ]);

    if (text.includes("FROM missions WHERE id=$1"))
      return rows([{ status: "running", finalReportId: null, resumePointer: null }]);

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

    if (text.includes("FROM agent_sessions") && text.includes("status='active'")) return rows([{}]);

    if (text.includes("FROM protected_operations"))
      return blocker === "operation"
        ? rows([
            {
              protectedOperationId: "66666666-6666-4666-8666-666666666666",
              operationId: "mutation-1",
              objectiveId,
              runId: null,
              praxisSessionId: "77777777-7777-4777-8777-777777777777",
              state: "recovery_required",
              mutationOutcome: "unknown",
              failureCode: "MUTATION_OUTCOME_UNKNOWN",
            },
          ])
        : rows();

    if (text.includes("FROM adaptive_operations o")) return rows();

    if (text.includes("FROM adaptive_sessions"))
      return blocker === "authoring"
        ? rows([
            {
              praxisSessionId: "77777777-7777-4777-8777-777777777777",
              objectiveId,
              state: "active",
              reasonCode: null,
            },
          ])
        : rows();

    if (text.includes("FROM runs WHERE mission_id"))
      return blocker === "run"
        ? rows([{ id: "88888888-8888-4888-8888-888888888888", objectiveId, state: "running" }])
        : rows();

    if (text.includes("FROM attempts a") && text.includes("a.completed_at IS NULL"))
      return blocker === "attempt"
        ? rows([
            {
              attemptId: "99999999-9999-4999-8999-999999999999",
              runId: "88888888-8888-4888-8888-888888888888",
              objectiveId,
              state: "running",
            },
          ])
        : rows();

    if (text.includes("FROM mission_objective_orchestration x"))
      return blocker === "orchestration"
        ? rows([
            {
              objectiveId,
              runId: null,
              state: "ready",
              reasonCode: null,
              evidenceRecommendationId: null,
            },
          ])
        : rows();

    return rows();
  });
}

describe("Mission completion safety", () => {
  it("returns canonical blocker identity in the ordinary Mission read", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([{ id: missionId, status: "running", revision: 4 }]);
      if (text.includes("FROM missions m WHERE m.id=$1"))
        return rows([
          {
            id: missionId,
            projectId: "55555555-5555-4555-8555-555555555555",
            title: "Readiness",
            originalInstruction: "Expose the blocker.",
            status: "running",
            revision: 4,
            objectiveCount: 1,
            terminalObjectiveCount: 0,
            acceptedEvidenceCount: 0,
          },
        ]);
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", finalReportId: null, resumePointer: null }]);
      if (text.includes("SELECT o.id,o.title,o.description"))
        return rows([
          {
            id: objectiveId,
            title: "Pending objective",
            description: "",
            status: "pending",
            dependencies: [],
            completionCriteria: [{ description: "Done", required: true }],
            order: 0,
          },
        ]);
      if (
        text.includes("SELECT id,status FROM mission_objectives") &&
        text.includes("NOT (o.status")
      )
        return rows([{ id: objectiveId, status: "pending" }]);
      return rows();
    });
    const service = new MissionService({
      query,
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(service.get(principal, missionId)).resolves.toMatchObject({
      id: missionId,
      completionReadiness: {
        ready: false,
        missionId,
        blockers: [
          expect.objectContaining({
            code: "MISSION_OBJECTIVES_NOT_TERMINAL",
            objectiveId,
            state: "pending",
            nextActions: ["finalize_agent_work"],
          }),
        ],
      },
    });
  });

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
      query.mock.calls.some(([text]) => String(text).includes("INSERT INTO agent_sessions")),
    ).toBe(false);
  });

  it.each([
    ["authoring", "MISSION_RUNTIME_CLOSE_REQUIRED"],
    ["operation", "MUTATION_RECONCILIATION_REQUIRED"],
    ["run", "MISSION_RUNS_NOT_TERMINAL"],
    ["attempt", "MISSION_ATTEMPTS_NOT_TERMINAL"],
    ["orchestration", "MISSION_ORCHESTRATION_NOT_TERMINAL"],
  ] as const)("refuses final report publication while %s work remains", async (blocker, code) => {
    const query = publicationQuery(blocker);
    const service = serviceFor(query);

    await expect(service.publishReport(principal, missionId, publishInput)).rejects.toMatchObject({
      response: expect.objectContaining({
        code,
      }),
    });

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("UPDATE missions SET status='completed'"),
      ),
    ).toBe(false);
  });

  it("replays an already committed final report before terminal/session checks", async () => {
    let requestHash = "";

    const committed = {
      id: reportId,
      missionId,
      revision: 1,
      status: "published",
      snapshot: {
        mission: {
          id: missionId,
          title: "Completed Mission",
          originalInstruction: "Verify completion safety.",
          status: "completed",
          sourceRevision: 4,
        },
        overallConclusion: "Mission complete.",
        journeySummary: ["Verified completion."],
        remainingActions: [],
        objectiveResults: [],
        evidence: {},
        evidenceDigest: "a".repeat(64),
        recordingSelection: null,
        recording: null,
        recordingDigest: null,
        supersededAttemptCount: 0,
        generatedAt: new Date(0).toISOString(),
      },
      replayed: false,
    };

    const query = vi.fn(async (text: string, values: unknown[] = []) => {
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
    });

    const service = serviceFor(query);

    await expect(service.publishReport(principal, missionId, publishInput)).resolves.toMatchObject({
      id: reportId,
      missionId,
      status: "published",
      replayed: true,
    });

    expect(query.mock.calls.some(([text]) => String(text).includes("FROM agent_sessions"))).toBe(
      false,
    );

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("UPDATE missions SET status='completed'"),
      ),
    ).toBe(false);
  });

  it("refuses a fresh-key publication of a completed Mission with the canonical terminal readiness", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM missions m JOIN projects"))
        return rows([
          {
            id: missionId,
            projectId: "55555555-5555-4555-8555-555555555555",
            status: "completed",
            revision: 4,
          },
        ]);
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return rows();
      }
      if (text.includes('SELECT request_hash AS "requestHash"'))
        return rows([{ requestHash, response: null }]);
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "completed", finalReportId: reportId, resumePointer: null }]);
      return rows();
    });

    await expect(
      serviceFor(query).publishReport(principal, missionId, publishInput),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_TERMINAL",
        readiness: expect.objectContaining({
          ready: false,
          missionId,
          blockers: [expect.objectContaining({ code: "MISSION_TERMINAL", state: "completed" })],
        }),
      }),
    });
  });

  it("projects unknown mutation identity without recommending a retry", async () => {
    const query = publicationQuery("operation");
    const service = serviceFor(query);

    await expect(service.publishReport(principal, missionId, publishInput)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MUTATION_RECONCILIATION_REQUIRED",
        mutationOutcome: "unknown",
        readiness: {
          ready: false,
          missionId,
          truncated: false,
          totalBlockerCount: 1,
          blockers: [
            expect.objectContaining({
              objectiveId,
              praxisSessionId: "77777777-7777-4777-8777-777777777777",
              protectedOperationId: "66666666-6666-4666-8666-666666666666",
              operationId: "mutation-1",
              state: "unknown",
              resolution: "mutation_reconciliation_required",
              nextActions: ["reconcile_unknown_operation"],
            }),
          ],
        },
      }),
    });

    const rejection = (await service
      .publishReport(principal, missionId, publishInput)
      .catch((error: unknown) => error)) as {
      response: { readiness: { blockers: Array<{ safeActions: string[] }> } };
    };
    expect(rejection.response.readiness.blockers[0]!.safeActions).toContain("do_not_retry");
    expect(rejection.response.readiness.blockers[0]!.safeActions).not.toContain("retry_operation");
  });

  it("keeps applied mutation truth while projecting incomplete functional effect separately", async () => {
    const protectedOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", finalReportId: null, resumePointer: null }]);
      if (text.includes("FROM protected_operations"))
        return rows([
          {
            protectedOperationId,
            operationId: "applied-effect",
            objectiveId,
            runId: null,
            praxisSessionId: "77777777-7777-4777-8777-777777777777",
            state: "recovery_required",
            mutationOutcome: "applied",
            failureCode: "FUNCTIONAL_EFFECT_INCOMPLETE",
          },
        ]);
      return rows();
    });
    const service = serviceFor(query) as unknown as {
      loadCompletionReadiness: (
        query: never,
        missionId: string,
      ) => Promise<{ ready: boolean; blockers: Array<Record<string, unknown>> }>;
    };

    const readiness = await service.loadCompletionReadiness(query as never, missionId);

    expect(readiness).toMatchObject({
      ready: false,
      blockers: [
        expect.objectContaining({
          code: "EFFECT_OBSERVATION_REQUIRED",
          protectedOperationId,
          state: "recovery_required",
          resolution: "fresh_observation_required",
          nextActions: ["observe_praxis_session"],
        }),
      ],
    });
    expect(readiness.blockers[0]).not.toMatchObject({ state: "not_applied" });
  });

  it("projects evidence-selection context and reports a reportable running Mission as ready", async () => {
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const evidenceRecommendationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let awaitingEvidence = true;
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", finalReportId: null, resumePointer: null }]);
      if (text.includes("FROM mission_objective_orchestration x") && awaitingEvidence)
        return rows([
          {
            objectiveId,
            runId,
            state: "awaiting_evidence",
            reasonCode: null,
            evidenceRecommendationId,
          },
        ]);
      return rows();
    });
    const service = serviceFor(query) as unknown as {
      loadCompletionReadiness: (
        query: never,
        missionId: string,
      ) => Promise<{ ready: boolean; blockers: Array<Record<string, unknown>> }>;
    };

    await expect(service.loadCompletionReadiness(query as never, missionId)).resolves.toMatchObject(
      {
        ready: false,
        blockers: [
          expect.objectContaining({
            code: "EVIDENCE_SELECTION_REQUIRED",
            objectiveId,
            runId,
            evidenceRecommendationId,
            resolution: "evidence_selection_required",
          }),
        ],
      },
    );

    awaitingEvidence = false;
    await expect(service.loadCompletionReadiness(query as never, missionId)).resolves.toEqual({
      ready: true,
      missionId,
      blockers: [],
      truncated: false,
      totalBlockerCount: 0,
    });
  });

  it("projects a completed Mission as canonically terminal even with an existing report", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "completed", finalReportId: reportId, resumePointer: null }]);
      return rows();
    });
    const service = serviceFor(query) as unknown as {
      loadCompletionReadiness: (
        query: never,
        missionId: string,
      ) => Promise<{ ready: boolean; blockers: Array<Record<string, unknown>> }>;
    };

    await expect(service.loadCompletionReadiness(query as never, missionId)).resolves.toMatchObject(
      {
        ready: false,
        blockers: [expect.objectContaining({ code: "MISSION_TERMINAL", state: "completed" })],
      },
    );
  });

  it("truthfully reports when canonical blockers are truncated", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", finalReportId: null, resumePointer: null }]);
      if (text.includes("FROM protected_operations"))
        return rows(
          Array.from({ length: 501 }, (_, index) => ({
            protectedOperationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            operationId: `operation-${index}`,
            objectiveId,
            runId: null,
            praxisSessionId: null,
            state: "recovery_required",
            mutationOutcome: "unknown",
            failureCode: "MUTATION_OUTCOME_UNKNOWN",
          })),
        );
      return rows();
    });
    const service = serviceFor(query) as unknown as {
      loadCompletionReadiness: (
        query: never,
        missionId: string,
      ) => Promise<{
        ready: boolean;
        blockers: Array<Record<string, unknown>>;
        truncated: boolean;
        totalBlockerCount: number;
      }>;
    };

    await expect(service.loadCompletionReadiness(query as never, missionId)).resolves.toMatchObject(
      {
        ready: false,
        truncated: true,
        totalBlockerCount: 501,
        blockers: expect.any(Array),
      },
    );
    const readiness = await service.loadCompletionReadiness(query as never, missionId);
    expect(readiness.blockers).toHaveLength(500);
  });

  it("applies Mission and Objective scope to every Objective-finalization readiness query", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM missions WHERE id=$1"))
        return rows([{ status: "running", finalReportId: null, resumePointer: null }]);
      return rows();
    });
    const service = serviceFor(query) as unknown as {
      loadCompletionReadiness: (
        query: never,
        missionId: string,
        objectiveId: string,
      ) => Promise<unknown>;
    };

    await service.loadCompletionReadiness(query as never, missionId, objectiveId);

    const scoped = calls.filter(({ text }) =>
      ["protected_operations", "adaptive_operations", "adaptive_sessions"].some((table) =>
        text.includes(table),
      ),
    );
    expect(scoped).toHaveLength(3);
    expect(scoped.every(({ values }) => values[0] === missionId && values[1] === objectiveId)).toBe(
      true,
    );
  });
});
