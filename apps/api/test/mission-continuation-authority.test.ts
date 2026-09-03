import { createMissionSchema, startAgentSessionSchema } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { MissionService } from "../src/missions/mission.service.js";

const projectId = "11111111-1111-4111-8111-111111111111";

const missionId = "22222222-2222-4222-8222-222222222222";

const principal = {
  kind: "service",
  subject: "scry-service",
} as const;

const continuationAuthority = {
  confirmedUserAuthorized: true as const,
  selection: "continue_existing_mission" as const,
  source: "followup_explicit_choice" as const,
};

const distinctAuthority = {
  confirmedUserAuthorized: true as const,
  selection: "start_distinct_mission" as const,
  source: "followup_explicit_choice" as const,
};

describe("Mission continuation authority", () => {
  it("rejects agent-session continuation without explicit user authority", () => {
    const parsed = startAgentSessionSchema.safeParse({
      provider: "codex",
      instructionSnapshot: "Continue related work",
      idempotencyKey: "continuation-test-0001",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts agent-session continuation with explicit user authority", () => {
    const parsed = startAgentSessionSchema.safeParse({
      provider: "codex",
      instructionSnapshot: "Continue related work",
      idempotencyKey: "continuation-test-0002",
      continuationAuthority,
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps ordinary new Mission creation free of unrelated confirmation ceremony", () => {
    const parsed = createMissionSchema.safeParse({
      title: "Unrelated new work",
      originalInstruction: "Perform unrelated new work.",
      provider: "codex",
      instructionSnapshot: "Perform unrelated new work.",
      idempotencyKey: "new-mission-test-0001",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects distinctReason without explicit new-work authority", () => {
    const parsed = createMissionSchema.safeParse({
      title: "Related work",
      originalInstruction: "Perform related work.",
      provider: "codex",
      instructionSnapshot: "Perform related work.",
      idempotencyKey: "distinct-test-0001",
      distinctReason: "The user explicitly requested separate work.",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts intentional distinct work with explicit user authority", () => {
    const parsed = createMissionSchema.safeParse({
      title: "Related work",
      originalInstruction: "Perform related work.",
      provider: "codex",
      instructionSnapshot: "Perform related work.",
      idempotencyKey: "distinct-test-0002",
      distinctReason: "The user explicitly requested separate work.",
      distinctAuthority,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects distinct authority when no distinct work is being requested", () => {
    const parsed = createMissionSchema.safeParse({
      title: "Normal work",
      originalInstruction: "Perform normal work.",
      provider: "codex",
      instructionSnapshot: "Perform normal work.",
      idempotencyKey: "distinct-test-0003",
      distinctAuthority,
    });

    expect(parsed.success).toBe(false);
  });

  it("fails closed in MissionService before creating a resumed agent session", async () => {
    const transaction = vi.fn();

    const service = new MissionService({
      transaction,
    } as never);

    let code = "none";

    try {
      await service.startSession(principal as never, missionId, {
        provider: "codex",
        instructionSnapshot: "Silent resume",
        idempotencyKey: "service-resume-test-0001",
      } as never);
    } catch (error) {
      const response =
        typeof error === "object" &&
        error !== null &&
        "getResponse" in error &&
        typeof (
          error as {
            getResponse?: unknown;
          }
        ).getResponse === "function"
          ? (
              error as {
                getResponse(): unknown;
              }
            ).getResponse()
          : null;

      code =
        typeof response === "object" && response !== null && "code" in response
          ? String(
              (
                response as {
                  code: unknown;
                }
              ).code,
            )
          : "unknown";
    }

    expect(code).toBe("MISSION_CONTINUATION_AUTHORITY_REQUIRED");

    expect(transaction).not.toHaveBeenCalled();
  });

  it("reopens the exact blocked Objective after an explicitly resumed provider interruption", async () => {
    const objectiveId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("FROM missions m JOIN projects"))
        return {
          rowCount: 1,
          rows: [
            {
              id: missionId,
              projectId,
              status: "blocked",
              revision: 4,
              currentObjectiveId: objectiveId,
              resumePointer: {
                objectiveId,
                recommendedAction: "review_failure",
                runId,
                explanation: "MODEL_PROVIDER_ERROR",
              },
            },
          ],
        };
      if (text.includes("SELECT id,status FROM agent_sessions")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM mission_objectives objective"))
        return { rowCount: 1, rows: [{ status: "blocked" }] };
      if (text.includes("session.terminal_outcome AS"))
        return {
          rowCount: 1,
          rows: [
            { terminalOutcome: "provider_failure", terminationReason: "MODEL_PROVIDER_ERROR" },
          ],
        };
      if (text.includes('AS "unresolvedMutation"'))
        return {
          rowCount: 1,
          rows: [
            {
              unresolvedMutation: false,
              unresolvedProtectedOperation: false,
              livePraxisSession: false,
              nonterminalRun: false,
            },
          ],
        };
      return { rowCount: 1, rows: [] };
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.startSession(principal as never, missionId, {
        provider: "codex",
        instructionSnapshot: "Continue after provider interruption",
        idempotencyKey: "provider-interruption-resume",
        continuationAuthority,
      }),
    ).resolves.toMatchObject({ missionId, status: "active" });

    const sql = statements.join("\n");
    expect(sql).toContain("unresolved_adaptive_unknown_operations");
    expect(sql).toContain("UPDATE mission_objectives SET status='pending'");
    expect(sql).toContain("UPDATE mission_objective_orchestration");
    expect(sql).toContain("resume_pointer=CASE");
  });

  it("does not relabel a system-blocked Objective as resumable provider interruption", async () => {
    const objectiveId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM missions m JOIN projects"))
        return {
          rowCount: 1,
          rows: [
            {
              id: missionId,
              projectId,
              status: "blocked",
              revision: 4,
              currentObjectiveId: objectiveId,
              resumePointer: {
                objectiveId,
                recommendedAction: "review_failure",
                runId,
                explanation: "EXTERNAL_AGENT_BLOCKED_SYSTEM",
              },
            },
          ],
        };
      if (text.includes("SELECT id,status FROM agent_sessions")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM mission_objectives objective"))
        return { rowCount: 1, rows: [{ status: "blocked" }] };
      if (text.includes("session.terminal_outcome AS"))
        return {
          rowCount: 1,
          rows: [
            {
              terminalOutcome: "blocked_system",
              terminationReason: "EXTERNAL_AGENT_BLOCKED_SYSTEM",
            },
          ],
        };
      return { rowCount: 1, rows: [] };
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.startSession(principal as never, missionId, {
        provider: "codex",
        instructionSnapshot: "Continue blocked work",
        idempotencyKey: "system-blocked-resume",
        continuationAuthority,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MISSION_OBJECTIVE_RESUME_NOT_AVAILABLE" }),
    });
  });

  it("keeps UNKNOWN fenced when a provider-interrupted Objective is resumed", async () => {
    const objectiveId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    const statements: string[] = [];
    const query = vi.fn(async (text: string) => {
      statements.push(text);
      if (text.includes("FROM missions m JOIN projects"))
        return {
          rowCount: 1,
          rows: [
            {
              id: missionId,
              projectId,
              status: "blocked",
              revision: 4,
              currentObjectiveId: objectiveId,
              resumePointer: {
                objectiveId,
                recommendedAction: "review_failure",
                runId,
                explanation: "MODEL_PROVIDER_ERROR",
              },
            },
          ],
        };
      if (text.includes("SELECT id,status FROM agent_sessions")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM mission_objectives objective"))
        return { rowCount: 1, rows: [{ status: "blocked", executionMode: null }] };
      if (text.includes("session.terminal_outcome AS"))
        return {
          rowCount: 1,
          rows: [
            { terminalOutcome: "provider_failure", terminationReason: "MODEL_PROVIDER_ERROR" },
          ],
        };
      if (text.includes('AS "unresolvedMutation"'))
        return {
          rowCount: 1,
          rows: [
            {
              unresolvedMutation: true,
              unresolvedProtectedOperation: false,
              unresolvedEffectObservation: false,
              livePraxisSession: false,
              nonterminalRun: false,
            },
          ],
        };
      return { rowCount: 1, rows: [] };
    });
    const service = new MissionService({
      transaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    } as never);

    await expect(
      service.startSession(principal as never, missionId, {
        provider: "codex",
        instructionSnapshot: "Continue after provider interruption",
        idempotencyKey: "provider-interruption-unknown",
        continuationAuthority,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECONCILIATION_REQUIRED",
        mutationOutcome: "unknown",
        safeActions: expect.arrayContaining(["do_not_retry"]),
      }),
    });
    expect(statements.join("\n")).not.toContain("UPDATE mission_objectives SET status='pending'");
  });

  it("fails closed in MissionService before creating unauthorized distinct work", async () => {
    const transaction = vi.fn();

    const service = new MissionService({
      transaction,
    } as never);

    let code = "none";

    try {
      await service.create(principal as never, projectId, {
        title: "Related work",
        originalInstruction: "Perform related work.",
        provider: "codex",
        instructionSnapshot: "Perform related work.",
        idempotencyKey: "service-distinct-test-0001",
        distinctReason: "Agent invented a distinct reason.",
      } as never);
    } catch (error) {
      const response =
        typeof error === "object" &&
        error !== null &&
        "getResponse" in error &&
        typeof (
          error as {
            getResponse?: unknown;
          }
        ).getResponse === "function"
          ? (
              error as {
                getResponse(): unknown;
              }
            ).getResponse()
          : null;

      code =
        typeof response === "object" && response !== null && "code" in response
          ? String(
              (
                response as {
                  code: unknown;
                }
              ).code,
            )
          : "unknown";
    }

    expect(code).toBe("MISSION_DISTINCT_WORK_AUTHORITY_REQUIRED");

    expect(transaction).not.toHaveBeenCalled();
  });
});
