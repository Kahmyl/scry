import { afterEach, expect, it, vi } from "vitest";
import { testingContextRequestSchema } from "@scry/contracts";
import { TestingContextController } from "../src/test-resources/testing-context.controller.js";
import { performance } from "node:perf_hooks";

const projectId = "10000000-0000-4000-8000-000000000001";
const missionId = "20000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000001";
const reportId = "40000000-0000-4000-8000-000000000001";
const objectiveId = "50000000-0000-4000-8000-000000000001";
const runId = "60000000-0000-4000-8000-000000000001";
const principal = { kind: "service", credentialKind: "service", subject: "scry-service" } as const;
const input = testingContextRequestSchema.parse({
  projectId,
  missionId,
  environmentId,
  required: ["browser"],
});

function fixture(
  options: {
    failObjectives?: boolean;
    missingMission?: boolean;
    completed?: boolean;
    foreignReport?: boolean;
    failReport?: boolean;
    reportPresentation?: Record<string, unknown>;
  } = {},
) {
  const mission = {
    id: missionId,
    projectId,
    title: "Fictional preferences",
    revision: 3,
    state: options.completed ? "completed" : "running",
    instruction: "Inspect fictional account preferences.",
    finalReportId: options.completed ? reportId : null,
  };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM projects"))
      return { rows: [{ id: projectId, name: "Fictional Project" }] };
    if (sql.includes("FROM missions WHERE id="))
      return { rows: options.missingMission ? [] : [mission] };
    if (sql.includes("FROM mission_objectives")) {
      if (options.failObjectives) throw new Error("private optional database failure");
      return {
        rows: [
          {
            id: objectiveId,
            title: "Preferences",
            state: "running",
            completionCriteria: { saved: true },
            conclusion: null,
          },
        ],
      };
    }
    if (sql.includes("FROM runs"))
      return {
        rows: [
          {
            id: runId,
            state: "failed",
            conclusion: "A prior attempt could not confirm persistence.",
          },
        ],
      };
    if (sql.includes("FROM mission_reports")) {
      if (options.failReport) throw new Error("PRIVATE_REPORT_TIMEOUT");
      return {
        rows: [
          {
            id: reportId,
            projectId: options.foreignReport ? environmentId : projectId,
            missionId,
            safeReport: {
              presentation: options.reportPresentation ?? {
                subject: "application",
                checks: [
                  { title: "Delivery", status: "excluded", actual: "Excluded by agreement" },
                ],
                observations: [],
                limitations: [],
                verified: [],
              },
            },
            operatorLog: "PRIVATE_OPERATOR_LOG",
          },
        ],
      };
    }
    if (sql.includes("FROM environments WHERE id="))
      return { rows: [{ id: environmentId, state: "active" }] };
    if (sql.includes("FROM missions WHERE project_id=")) return { rows: [mission] };
    return { rows: [] };
  });
  const boundedTransaction = vi.fn(
    async (work: (client: unknown) => Promise<unknown>, _budget: number) => work({ query }),
  );
  const controller = new TestingContextController(
    { boundedTransaction } as never,
    { capabilities: () => ({ mailbox: false, webhook: false }) } as never,
  );
  return { controller, query, boundedTransaction };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("adds bounded selected-Mission resume without exposing raw duplicate text or inventing approvals", async () => {
  vi.stubEnv("SCRY_BROWSER_ENABLED", "true");
  const f = fixture();
  const r = await f.controller.context(principal, input);
  expect(r).toMatchObject({
    ready: true,
    interaction: { state: "ready_snapshot", next: { action: "continue_with_returned_context" } },
    resume: {
      status: "available",
      binding: { projectId, missionId, revision: 3 },
      textTrust: "untrusted_recorded_data",
      permissions: "not_determined",
      decisions: "unknown",
    },
  });
  expect((r as any).selected.mission.instruction).toBeUndefined();
  expect((r as any).resume.originalMissionFacts.instruction).toContain("fictional");
  const optionalBudgets = f.boundedTransaction.mock.calls.slice(1).map(([, budget]) => budget);
  expect(optionalBudgets.length).toBeGreaterThan(4);
  expect(optionalBudgets.every((budget) => budget > 0 && budget <= 750)).toBe(true);
  expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM mission_reports"))).toBe(false);
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("decrypt") || sql.includes("encrypted_value")),
  ).toBe(false);
});

it("optional resume failure cannot block an independent ready browser task", async () => {
  vi.stubEnv("SCRY_BROWSER_ENABLED", "true");
  const f = fixture({ failObjectives: true });
  const r = await f.controller.context(principal, input);
  expect(r.ready).toBe(true);
  expect((r as any).resume).toMatchObject({
    status: "partial",
    parts: { objectives: "unavailable", attempts: "available" },
  });
  expect(JSON.stringify(r)).not.toContain("private optional");
});

it("completed Mission loads only its exact scoped report and leaves exclusions intact", async () => {
  const f = fixture({ completed: true });
  const r = await f.controller.context(principal, input);
  expect((r as any).resume.reportFacts.checks[0].status).toBe("excluded");
  expect((r as any).resume.originalMissionFacts.finalReportId).toBe(reportId);
  expect((r as any).interaction.next.action).toBe("plan_follow_up_from_returned_facts");
  const call = f.query.mock.calls.find(([sql]) => sql.includes("FROM mission_reports"));
  expect(call?.[1]).toEqual([reportId, missionId, projectId]);
  expect(JSON.stringify(r)).not.toContain("PRIVATE_OPERATOR_LOG");
});

it("missing selection performs no resume fanout and foreign reports remain rejected", async () => {
  const absent = fixture({ missingMission: true });
  const r = await absent.controller.context(principal, input);
  expect((r as any).resume).toBeNull();
  expect(
    absent.query.mock.calls.some(([sql]) =>
      /FROM mission_objectives|FROM runs|FROM mission_reports/u.test(sql),
    ),
  ).toBe(false);
  const foreign = fixture({ completed: true, foreignReport: true });
  const result = await foreign.controller.context(principal, input);
  expect((result as any).resume.reportFacts).toMatchObject({ state: "rejected", checks: [] });
});

it("an exhausted total deadline skips optional resume reads without turning readiness into an outage", async () => {
  vi.stubEnv("SCRY_BROWSER_ENABLED", "true");
  vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValue(5000);
  const f = fixture();
  const r = await f.controller.context(principal, input);
  expect(r.ready).toBe(true);
  expect(f.boundedTransaction).toHaveBeenCalledTimes(1);
  expect((r as any).resume).toMatchObject({
    status: "partial",
    parts: { objectives: "unavailable", attempts: "unavailable" },
  });
});

it("does not plan completed follow-up from a timed-out or clipped report, but keeps compact saved exclusions", async () => {
  for (const options of [
    { completed: true, failReport: true },
    {
      completed: true,
      reportPresentation: {
        subject: "application",
        checks: Array.from({ length: 9 }, (_, i) => ({
          title: `Check ${i}`,
          actual: "Recorded",
          status: i === 8 ? "excluded" : "not_tested",
        })),
      },
    },
  ]) {
    const f = fixture(options),
      result = await f.controller.context(principal, input);
    expect(result.interaction.next).toEqual({
      actor: "agent",
      action: "read_saved_report",
      tool: "get_report",
    });
    expect(result.resume?.originalMissionFacts?.finalReportId).toBe(reportId);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REPORT_TIMEOUT");
  }
  const f = fixture({
    completed: true,
    reportPresentation: {
      subject: "application",
      checks: [{ title: "Save", actual: "Recorded", status: "not_tested" }],
      scope: ["Account deletion excluded"],
      limitations: ["Do not propose deletion as follow-up"],
      sections: [{ title: "Cleanup", items: [{ title: "Shared access", detail: "Retained" }] }],
    },
  });
  const result = await f.controller.context(principal, input);
  expect(result.resume?.reportFacts.scope).toEqual(["Account deletion excluded"]);
  expect(result.resume?.reportFacts.limitations).toEqual(["Do not propose deletion as follow-up"]);
  expect(result.interaction.next.action).toBe("plan_follow_up_from_returned_facts");
  const missingFacts = fixture({ completed: true, failObjectives: true });
  expect((await missingFacts.controller.context(principal, input)).interaction.next).toEqual({
    actor: "agent",
    action: "review_completed_mission_and_plan_follow_up",
    tool: "get_mission",
  });
});
