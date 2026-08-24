import { describe, expect, it, vi } from "vitest";
import { OrchestrationService } from "../src/orchestration/index.js";
import { MissionService } from "../src/missions/index.js";

describe("Mission lifecycle regression", () => {
  it("marks an idempotent Mission creation replay as replayed", async () => {
    const missionId = "11111111-1111-4111-8111-111111111111";
    const agentSessionId = "22222222-2222-4222-8222-222222222222";
    let requestHash = "";

    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SELECT 1 FROM projects"))
        return {
          rowCount: 1,
          rows: [{}],
        };

      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return {
          rowCount: 0,
          rows: [],
        };
      }

      if (
        text.includes('SELECT request_hash AS "requestHash",response') &&
        text.includes("FROM idempotency_records")
      )
        return {
          rowCount: 1,
          rows: [
            {
              requestHash,
              response: {
                missionId,
                agentSessionId,
                status: "planning",
                replayed: false,
              },
            },
          ],
        };

      throw new Error(`UNEXPECTED_QUERY: ${text}`);
    });

    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.create(
        {
          kind: "service",
          subject: "scry-service",
        },
        "33333333-3333-4333-8333-333333333333",
        {
          title: "Replay",
          originalInstruction: "Replay Mission creation.",
          provider: "codex",
          instructionSnapshot: "Replay Mission creation.",
          idempotencyKey: "mission-create-replay",
        },
      ),
    ).resolves.toEqual({
      missionId,
      agentSessionId,
      status: "planning",
      replayed: true,
    });

    expect(query.mock.calls.some(([text]) => String(text).includes("INSERT INTO missions"))).toBe(
      false,
    );

    expect(
      query.mock.calls.some(([text]) => String(text).includes("INSERT INTO agent_sessions")),
    ).toBe(false);
  });

  const waitingContextQuery = () => {
    let requestHash = "";
    return vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("idempotency_records") && text.includes("SELECT"))
        return {
          rowCount: 1,
          rows: [{ requestHash, response: null }],
        };
      if (text.includes("FROM missions m JOIN projects"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              status: "awaiting_user",
              revision: 7,
            },
          ],
        };
      if (text.includes("FROM missions WHERE id=$1"))
        return {
          rowCount: 1,
          rows: [{ status: "awaiting_user", finalReportId: null, resumePointer: null }],
        };
      if (text.includes("FROM agent_sessions")) return { rowCount: 1, rows: [{}] };
      if (text.includes("SELECT 1 FROM mission_objectives")) return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    });
  };

  it("does not terminalize an Objective while its Mission is awaiting user input", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("INSERT INTO idempotency_records")) requestHash = String(values[2]);
      if (text.includes("idempotency_records") && text.includes("SELECT"))
        return { rowCount: 1, rows: [{ requestHash, response: null }] };
      if (text.includes("FROM missions m JOIN projects"))
        return { rowCount: 1, rows: [{ status: "awaiting_user", revision: 7 }] };
      return { rowCount: 1, rows: [] };
    });
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.finalizeAgentWork(
        { kind: "service", subject: "scry-service" },
        {
          kind: "terminal_objective",
          missionId: "11111111-1111-4111-8111-111111111111",
          objectiveId: "22222222-2222-4222-8222-222222222222",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          objectiveStatus: "failed",
          conclusion: "Input was unavailable",
          sessionStatus: "failed",
          expectedMissionRevision: 7,
          idempotencyKey: "do-not-terminalize-waiting",
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "AWAITING_USER_IS_NON_TERMINAL",
        terminal: false,
        sameMissionResumable: true,
        sameObjectiveResumable: true,
        shouldPublishFinalReport: false,
      }),
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes("UPDATE mission_objectives")),
    ).toBe(false);
  });

  it("blocks the update-objective sibling path while awaiting user input", async () => {
    const query = waitingContextQuery();
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.updateObjective(
        { kind: "service", subject: "scry-service" },
        "22222222-2222-4222-8222-222222222222",
        {
          missionId: "11111111-1111-4111-8111-111111111111",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          status: "failed",
          conclusion: "Input is pending",
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "AWAITING_USER_IS_NON_TERMINAL",
        shouldPublishFinalReport: false,
      }),
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes("UPDATE mission_objectives")),
    ).toBe(false);
  });

  it("rejects a final report while the Mission is awaiting user input", async () => {
    const query = waitingContextQuery();
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.publishReport(
        { kind: "service", subject: "scry-service" },
        "11111111-1111-4111-8111-111111111111",
        {
          missionId: "11111111-1111-4111-8111-111111111111",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          overallConclusion: "Final",
          journeySummary: [],
          remainingActions: [],
          expectedRevision: 7,
          idempotencyKey: "awaiting-user-report-must-remain-non-terminal",
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "AWAITING_USER_REPORT_NOT_FINAL",
        shouldPublishFinalReport: false,
        readiness: expect.objectContaining({
          ready: false,
          blockers: [expect.objectContaining({ code: "AWAITING_USER_REPORT_NOT_FINAL" })],
        }),
      }),
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes("FROM mission_objectives o")),
    ).toBe(true);
  });

  it("does not attach an awaiting-user pointer to an already terminal Objective", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects"))
        return { rowCount: 1, rows: [{ status: "running", revision: 7 }] };
      if (text.includes("FROM agent_sessions") || text.includes("SELECT 1 FROM mission_objectives"))
        return { rowCount: 1, rows: [{}] };
      if (text.includes("SELECT status FROM mission_objectives"))
        return { rowCount: 1, rows: [{ status: "passed" }] };
      return { rowCount: 0, rows: [] };
    });
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.updateResumePointer(
        { kind: "service", subject: "scry-service" },
        "11111111-1111-4111-8111-111111111111",
        {
          missionId: "11111111-1111-4111-8111-111111111111",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          pointer: {
            objectiveId: "22222222-2222-4222-8222-222222222222",
            recommendedAction: "await_user",
            explanation: "Wait",
            externalInput: { fulfillmentPaths: [{}] },
          },
        } as never,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "TERMINAL_OBJECTIVE_CANNOT_AWAIT_USER",
      }),
    });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes("UPDATE missions SET resume_pointer"),
      ),
    ).toBe(false);
  });

  it("requires a supported fulfillment path on newly written human waits", async () => {
    const query = waitingContextQuery();
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.updateResumePointer(
        { kind: "service", subject: "scry-service" },
        "11111111-1111-4111-8111-111111111111",
        {
          missionId: "11111111-1111-4111-8111-111111111111",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          pointer: {
            objectiveId: "22222222-2222-4222-8222-222222222222",
            recommendedAction: "await_user",
            explanation: "Wait",
            externalInput: { fulfillmentPaths: [] },
          },
        } as never,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "HUMAN_FULFILLMENT_PATH_REQUIRED",
      }),
    });
  });

  it("refuses finalization while authoring can still dispatch", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("INSERT INTO idempotency_records")) requestHash = String(values[2]);
      if (text.includes("idempotency_records") && text.includes("SELECT"))
        return { rowCount: 1, rows: [{ requestHash, response: null }] };
      if (text.includes("FROM missions m JOIN projects"))
        return { rowCount: 1, rows: [{ status: "running", revision: 1 }] };
      if (text.includes("FROM missions WHERE id=$1"))
        return {
          rowCount: 1,
          rows: [{ status: "running", finalReportId: null, resumePointer: null }],
        };
      if (text.includes("FROM agent_sessions") || text.includes("FROM mission_objectives"))
        return { rowCount: 1, rows: [{ status: "running" }] };
      if (text.includes("FROM protected_operations") || text.includes("FROM adaptive_operations"))
        return { rowCount: 0, rows: [] };
      if (text.includes("FROM adaptive_sessions"))
        return {
          rowCount: 1,
          rows: [
            {
              praxisSessionId: "55555555-5555-4555-8555-555555555555",
              objectiveId: "22222222-2222-4222-8222-222222222222",
              state: "active",
              reasonCode: null,
            },
          ],
        };
      return { rowCount: 1, rows: [] };
    });
    const service = new MissionService({ transaction: (work: any) => work({ query }) } as never);
    await expect(
      service.finalizeAgentWork(
        { kind: "service", subject: "scry-service" },
        {
          kind: "terminal_objective",
          missionId: "11111111-1111-4111-8111-111111111111",
          objectiveId: "22222222-2222-4222-8222-222222222222",
          agentSessionId: "33333333-3333-4333-8333-333333333333",
          objectiveStatus: "passed",
          conclusion: "Verified",
          sessionStatus: "completed",
          expectedMissionRevision: 1,
          idempotencyKey: "finalize-active-authoring",
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MISSION_RUNTIME_CLOSE_REQUIRED" }),
    });
    expect(
      query.mock.calls.some(([text]) => String(text).includes("UPDATE mission_objectives")),
    ).toBe(false);
  });

  it("atomically enters and leaves durable non-terminal user waiting", async () => {
    const objectiveId = "33333333-3333-4333-8333-333333333333";
    const missionId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const updates: Array<{ text: string; values: unknown[] }> = [];
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("FROM missions m JOIN projects"))
        return { rowCount: 1, rows: [{ id: missionId, status: "running", revision: 1 }] };
      if (text.includes("FROM agent_sessions") || text.includes("FROM mission_objectives"))
        return { rowCount: 1, rows: [{}] };
      if (text.includes("UPDATE missions SET resume_pointer")) updates.push({ text, values });
      return { rowCount: 1, rows: [{}] };
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);
    const context = { missionId, agentSessionId: sessionId };
    const externalInput = {
      condition: "USER_AUTHORIZATION_REQUIRED" as const,
      cause: "A policy change requires user authority.",
      effectState: "unknown" as const,
      authority: {
        required: true,
        type: "user" as const,
        reason: "User authorization is required.",
      },
      availableCapabilities: [
        "grant_mission_execution_authorization" as const,
        "resume_mission" as const,
        "cancel_mission_orchestration" as const,
      ],
      fulfillmentPaths: [
        {
          kind: "approval" as const,
          humanAction: "Approve the requested authority.",
          agentExposure: "authorization_only" as const,
          result: "Authority becomes available to the same task.",
          availableCapabilities: [
            "grant_mission_execution_authorization" as const,
            "resume_mission" as const,
          ],
          continuation: {
            sameMission: true as const,
            sameObjective: true as const,
            replacementMissionRequired: false as const,
            resumeWith: "resume_mission" as const,
          },
        },
      ],
      constraints: ["Do not retry until authoritative state is observed."],
      consequences: ["Approval permits revalidation only."],
      continuation: {
        retryCurrentOperation: false,
        freshObservationRequired: true,
        newOperationRequired: true,
        newDraftRequired: false,
        newSessionRequired: false,
      },
      waiting: true as const,
      terminal: false as const,
      lifecycle: {
        terminal: false as const,
        taskStillActive: true as const,
        sameMissionResumable: true as const,
        sameObjectiveResumable: true as const,
        shouldFinalize: false as const,
        shouldPublishFinalReport: false as const,
        shouldCreateReplacementMission: false as const,
        requiredNextStep: "fulfill_human_prerequisite_then_resume" as const,
      },
      resumeRef: objectiveId,
    };
    await service.updateResumePointer({ kind: "service", subject: "scry-service" }, missionId, {
      ...context,
      pointer: {
        objectiveId,
        recommendedAction: "await_user",
        explanation: "Waiting for authorization",
        externalInput,
      },
    });
    await service.updateResumePointer({ kind: "service", subject: "scry-service" }, missionId, {
      ...context,
      pointer: null,
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]!.text).toContain("WHEN $4 THEN 'awaiting_user'");
    expect(updates[0]!.values[3]).toBe(true);
    expect(JSON.parse(String(updates[0]!.values[1]))).toMatchObject({
      externalInput: { effectState: "unknown", terminal: false, resumeRef: objectiveId },
    });
    expect(updates[1]!.text).toContain("WHEN status='awaiting_user' THEN 'running'");
    expect(updates[1]!.values[3]).toBe(false);
  });

  it("projects Mission continuation context without stored browser or protected diagnostics", async () => {
    const forbiddenValues = [
      "fingerprint-canary",
      "selector-canary",
      "xpath-canary",
      "runtime-canary",
      "handle-canary",
      "dom-canary",
      "credential-canary",
      "token-canary",
      "clipboard-canary",
    ];
    const rawProbeResult = {
      pageFingerprint: forbiddenValues[0],
      nested: [{ selector: forbiddenValues[1], xpath: forbiddenValues[2] }],
      runtimeId: forbiddenValues[3],
      browserHandle: forbiddenValues[4],
      outerHTML: forbiddenValues[5],
      credentialValue: forbiddenValues[6],
      accessToken: forbiddenValues[7],
      clipboard: forbiddenValues[8],
    };
    const rawReport = {
      journey: [{ targetFingerprint: forbiddenValues[0], dom: forbiddenValues[5] }],
    };
    const database = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM missions m JOIN projects"))
          return { rowCount: 1, rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        if (text.includes("FROM missions m WHERE m.id"))
          return {
            rowCount: 1,
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                projectId: "22222222-2222-4222-8222-222222222222",
                title: "Safe Mission",
                originalInstruction: "Continue safely",
                status: "running",
                currentObjectiveId: "33333333-3333-4333-8333-333333333333",
                resumePointer: {
                  objectiveId: "33333333-3333-4333-8333-333333333333",
                  recommendedAction: "review_failure",
                  explanation: "Review bounded failure",
                },
                revision: 2,
                objectiveCount: 1,
                terminalObjectiveCount: 0,
                acceptedEvidenceCount: 0,
              },
            ],
          };
        if (text.includes("FROM mission_objectives o"))
          return {
            rowCount: 1,
            rows: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                title: "Safe objective",
                description: "Continue",
                status: "running",
                dependencies: [],
                completionCriteria: [],
                order: 0,
              },
            ],
          };
        if (text.includes("FROM mission_flow_links")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM runs r")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM accepted_evidence")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM mission_reports"))
          return {
            rowCount: 1,
            rows: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                revision: 1,
                status: "published",
                snapshot: rawReport,
              },
            ],
          };
        if (text.includes("FROM flow_drafts d"))
          return {
            rowCount: 1,
            rows: [
              {
                id: "55555555-5555-4555-8555-555555555555",
                objectiveId: "33333333-3333-4333-8333-333333333333",
                name: "Safe draft",
                state: "editing",
                version: 3,
                probes: [
                  {
                    id: "66666666-6666-4666-8666-666666666666",
                    level: "inspection",
                    state: "completed",
                    draftVersion: 3,
                    result: rawProbeResult,
                  },
                ],
                compilations: [
                  {
                    id: "77777777-7777-4777-8777-777777777777",
                    status: "failed",
                    draftVersion: 3,
                    diagnostics: [{ code: "SAFE_REASON", details: rawProbeResult }],
                  },
                ],
              },
            ],
          };
        return { rowCount: 0, rows: [] };
      }),
    };
    const mission = await new MissionService(database as never).get(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
    );
    const serialized = JSON.stringify(mission);
    for (const key of [
      "pageFingerprint",
      "targetFingerprint",
      "selector",
      "xpath",
      "runtimeId",
      "browserHandle",
      "outerHTML",
      "credentialValue",
      "accessToken",
      "clipboard",
      "snapshot",
      "result",
      "diagnostics",
    ]) {
      expect(serialized).not.toContain(key);
    }
    for (const value of forbiddenValues) expect(serialized).not.toContain(value);
    expect(mission).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      originalInstruction: "Continue safely",
      resumePointer: { explanation: "Review bounded failure" },
      flowProgress: {
        terminalRuns: 0,
        passedRuns: 0,
        needsAttentionRuns: 0,
        current: { kind: "authoring", name: "Safe draft", phase: "editing" },
        evidenceAvailable: false,
      },
      objectives: [{ title: "Safe objective" }],
      reports: [{ id: "44444444-4444-4444-8444-444444444444", status: "published" }],
      authoring: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          probes: [{ state: "completed" }],
          compilations: [{ status: "failed" }],
        },
      ],
    });
    expect(serialized.length).toBeLessThan(20_000);
    expect(rawProbeResult.pageFingerprint).toBe("fingerprint-canary");
    expect(rawReport.journey).toHaveLength(1);
  });

  it("orders Mission cards by creation time rather than recent activity", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return text.includes("SELECT 1 FROM projects")
          ? { rowCount: 1, rows: [{}] }
          : { rowCount: 0, rows: [] };
      }),
    };
    await new MissionService(database as never).list(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
    );
    expect(queries.at(-1)).toContain("ORDER BY m.created_at DESC,m.id DESC");
    expect(queries.at(-1)).not.toContain("ORDER BY m.updated_at DESC");
  });

  it("keeps terminal candidate outcomes awaiting evidence instead of declaring Objective failure", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("SELECT o.id,o.dependencies")) return { rowCount: 0, rows: [] };
        if (text.includes("SELECT x.objective_id,r.id run_id")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
    };
    const service = new OrchestrationService({} as never);
    await (
      service as unknown as { reconcileMission(c: unknown, id: string): Promise<void> }
    ).reconcileMission(client, "22222222-2222-4222-8222-222222222222");
    expect(queries[0]).toContain("EXISTS(SELECT 1 FROM accepted_evidence");
    expect(queries[0]).toContain("SET state='passed'");
    expect(queries[1]).toContain("SET status='running',resume_pointer=NULL");
    expect(queries[2]).toContain("WHEN r.state='queued' THEN 'queued'");
    expect(queries[2]).toContain("ELSE 'awaiting_evidence'");
    expect(queries[2]).toContain("x.state NOT IN ('passed','failed','blocked','cancelled')");
    expect(queries[3]).toContain("SET status='pending',conclusion=NULL");
    expect(queries.join("\n")).not.toContain("Execution failed and requires review");
  });

  it("requires selection when related non-terminal work already exists", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SELECT 1 FROM projects")) return { rowCount: 1, rows: [{}] };
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT request_hash"))
        return { rowCount: 1, rows: [{ requestHash, response: null }] };
      if (text.includes("FROM missions mission") && text.includes('"activeExecutionOwnership"'))
        return {
          rowCount: 1,
          rows: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              title: "Existing",
              status: "planning",
              purpose: "primary",
              latestExternalRunId: null,
              latestAgentSessionStatus: null,
              knownExternalRunIds: [],
              activeExternalRunIds: [],
              activeExecutionOwnership: true,
              unresolvedMutationRisk: false,
              outstandingReconciliation: false,
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    });
    const database = {
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
      query,
    };
    await expect(
      new MissionService(database as never).create(
        { kind: "service", subject: "scry-service" },
        "11111111-1111-4111-8111-111111111111",
        {
          title: "Existing",
          originalInstruction: "Continue this work",
          instructionSnapshot: "Continue this work",
          provider: "codex",
          idempotencyKey: "mission-regression-1",
        },
      ),
    ).rejects.toMatchObject({ response: { code: "MISSION_SELECTION_REQUIRED" } });
  });

  it("writes the final completed state into an immutable report snapshot", async () => {
    const responses = [
      {
        rows: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            revision: 7,
            title: "Mission",
            originalInstruction: "Test",
            status: "blocked",
          },
        ],
      },

      // Mission objectives.
      { rows: [] },

      // Accepted evidence.
      { rows: [] },

      // Superseded Attempt count.
      { rows: [{ count: 0 }] },

      // No active explicit recording selection.
      { rows: [] },

      // This synthetic lifecycle fixture is genuinely Run-free,
      // so recording=null is valid rather than auto-selecting Runs.
      { rows: [{ count: 0 }] },

      // No cross-Mission provenance for this legacy lifecycle fixture.
      { rows: [] },
    ];

    const query = vi.fn(async () => {
      const response = responses.shift();

      if (!response) throw new Error("UNEXPECTED_QUERY_AFTER_REPORT_SNAPSHOT_FIXTURE_EXHAUSTED");

      return {
        rowCount: response.rows.length,
        ...response,
      };
    });
    const snapshot = await (
      new MissionService({} as never) as unknown as {
        buildReportSnapshot(
          q: unknown,
          id: string,
          conclusion: string,
          journey: string[],
          actions: string[],
          status: string,
        ): Promise<{ mission: { status: string } }>;
      }
    ).buildReportSnapshot(
      query,
      "44444444-4444-4444-8444-444444444444",
      "Passed",
      ["Done"],
      [],
      "completed",
    );
    expect(snapshot.mission.status).toBe("completed");
  });
});
