import { describe, expect, it, vi } from "vitest";
import { OrchestrationService } from "../src/orchestration/index.js";
import { MissionService } from "../src/missions/index.js";

describe("Mission lifecycle regression", () => {
  it("projects Mission continuation context without stored browser or protected diagnostics", async () => {
    const forbiddenValues = [
      "fingerprint-canary", "selector-canary", "xpath-canary", "runtime-canary",
      "handle-canary", "dom-canary", "credential-canary", "token-canary", "clipboard-canary",
    ];
    const rawProbeResult = {
      pageFingerprint: forbiddenValues[0], nested: [{ selector: forbiddenValues[1], xpath: forbiddenValues[2] }],
      runtimeId: forbiddenValues[3], browserHandle: forbiddenValues[4], outerHTML: forbiddenValues[5],
      credentialValue: forbiddenValues[6], accessToken: forbiddenValues[7], clipboard: forbiddenValues[8],
    };
    const rawReport = { journey: [{ targetFingerprint: forbiddenValues[0], dom: forbiddenValues[5] }] };
    const database = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM missions m JOIN projects")) return { rowCount: 1, rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        if (text.includes("FROM missions m WHERE m.id")) return { rowCount: 1, rows: [{
          id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
          title: "Safe Mission", originalInstruction: "Continue safely", status: "running", currentObjectiveId: "33333333-3333-4333-8333-333333333333",
          resumePointer: { objectiveId: "33333333-3333-4333-8333-333333333333", recommendedAction: "review_failure", explanation: "Review bounded failure" },
          revision: 2, objectiveCount: 1, terminalObjectiveCount: 0, acceptedEvidenceCount: 0,
        }] };
        if (text.includes("FROM mission_objectives o")) return { rowCount: 1, rows: [{ id: "33333333-3333-4333-8333-333333333333", title: "Safe objective", description: "Continue", status: "running", dependencies: [], completionCriteria: [], order: 0 }] };
        if (text.includes("FROM mission_flow_links")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM runs r")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM accepted_evidence")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM mission_reports")) return { rowCount: 1, rows: [{ id: "44444444-4444-4444-8444-444444444444", revision: 1, status: "published", snapshot: rawReport }] };
        if (text.includes("FROM flow_drafts d")) return { rowCount: 1, rows: [{ id: "55555555-5555-4555-8555-555555555555", objectiveId: "33333333-3333-4333-8333-333333333333", name: "Safe draft", state: "editing", version: 3,
          probes: [{ id: "66666666-6666-4666-8666-666666666666", level: "inspection", state: "completed", draftVersion: 3, result: rawProbeResult }],
          compilations: [{ id: "77777777-7777-4777-8777-777777777777", status: "failed", draftVersion: 3, diagnostics: [{ code: "SAFE_REASON", details: rawProbeResult }] }],
        }] };
        return { rowCount: 0, rows: [] };
      }),
    };
    const mission = await new MissionService(database as never).get(
      { kind: "service", subject: "scry-service" }, "11111111-1111-4111-8111-111111111111",
    );
    const serialized = JSON.stringify(mission);
    for (const key of ["pageFingerprint", "targetFingerprint", "selector", "xpath", "runtimeId", "browserHandle", "outerHTML", "credentialValue", "accessToken", "clipboard", "snapshot", "result", "diagnostics"]) {
      expect(serialized).not.toContain(key);
    }
    for (const value of forbiddenValues) expect(serialized).not.toContain(value);
    expect(mission).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", status: "running",
      resumePointer: { explanation: "Review bounded failure" }, objectives: [{ title: "Safe objective" }],
      reports: [{ id: "44444444-4444-4444-8444-444444444444", status: "published" }],
      authoring: [{ id: "55555555-5555-4555-8555-555555555555", probes: [{ state: "completed" }], compilations: [{ status: "failed" }] }],
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

  it("requires continuation when related non-terminal work already exists", async () => {
    let requestHash = "";
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SELECT 1 FROM projects")) return { rowCount: 1, rows: [{}] };
      if (text.includes("INSERT INTO idempotency_records")) {
        requestHash = String(values[2]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SELECT request_hash"))
        return { rowCount: 1, rows: [{ requestHash, response: null }] };
      if (text.includes("SELECT id,title,status,resume_pointer"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              title: "Existing",
              status: "planning",
              resumePointer: null,
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
    ).rejects.toMatchObject({ response: { code: "MISSION_CONTINUATION_REQUIRED" } });
  });

  it("writes the final completed state into an immutable report snapshot", async () => {
    const responses = [
      { rows: [{ title: "Mission", originalInstruction: "Test", status: "blocked" }] },
      { rows: [] },
      { rows: [{ count: 0 }] },
    ];
    const query = vi.fn(async () => ({ rowCount: 0, ...responses.shift() }));
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
