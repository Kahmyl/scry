import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserDashboardRepository } from "../src/browser-execution/repositories/browser-dashboard.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { runRecoveryStatus } from "../src/browser-execution/customer-reporting.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(url ? describe : describe.skip)("native action truth and recovery admission", () => {
  let db: Database, commands: BrowserCommandRepository, effects: BrowserExecutionRepository;
  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V1_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V2_ENABLED", "true");
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(db, cipher);
    effects = new BrowserExecutionRepository(db, cipher);
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    vi.unstubAllEnvs();
  });
  const submit = (session: string, tool = "browser_click", key = randomUUID()) =>
    commands.submit(session, {
      idempotencyKey: key,
      command: {
        kind: "browser_tool",
        tool,
        args: tool === "browser_click" ? { target: "e7" } : {},
      },
    });
  const partial = (): any => ({
    contractVersion: 2,
    planId: "test-refused-plan",
    complete: false,
    execution: "partial",
    businessOutcome: "unverified",
    reason: "guard_refused_before_dispatch",
    receipts: [
      { index: 0, actionId: "completed-action", execution: "completed" },
      {
        index: 1,
        actionId: "refused-action",
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        dispatch: {
          version: 1,
          state: "not_dispatched",
          source: "worker_guard",
          ownerGeneration: 1,
        },
      },
    ],
  });
  async function saved(result: any) {
    const session = await seedSession(db, effects, "https://fixture.example");
    const first = await submit(session);
    const claim = await commands.claim(first.commandId);
    await commands.complete(first.commandId, claim!.claim_token!, result);
    return { session, first };
  }
  it("allows a newly planned action after proven partial completion without replaying the prefix", async () => {
    const { session, first } = await saved(partial());
    const original = await commands.observe(first.commandId);
    expect(original.result).toMatchObject({
      execution: "partial",
      nativeActionFence: { state: "known" },
    });
    const next = await submit(session);
    expect(next.state).toBe("queued");
    const context = await commands.sessionContext(session);
    const status = runRecoveryStatus(
      await new BrowserDashboardRepository(db).recoveryStatus(undefined, context.runId),
    );
    expect(status.currentCommandId).toBe(next.commandId);
    expect((await commands.observe(first.commandId)).result).toEqual(original.result);
  });
  it.each([
    "version",
    "source",
    "generation",
    "index",
    "order",
    "unknown",
    "missing",
    "aggregate",
    "empty",
    "not-array",
    "aggregate-missing",
    "aggregate-null",
    "receipt-id",
    "duplicate-id",
  ])("fences malformed %s truth despite a caller-supplied known classification", async (kind) => {
    const r = partial(),
      last = r.receipts.at(-1);
    r.nativeActionFence = { version: 1, state: "known" };
    if (kind === "version") r.contractVersion = 1;
    if (kind === "source") last.dispatch.source = "agent_claim";
    if (kind === "generation") last.dispatch.ownerGeneration = 0;
    if (kind === "index") last.index = 0;
    if (kind === "order") r.receipts.reverse();
    if (kind === "unknown") r.receipts[0].execution = "unknown";
    if (kind === "missing") delete last.dispatch;
    if (kind === "aggregate") r.execution = "completed";
    if (kind === "empty") r.receipts = [];
    if (kind === "not-array") r.receipts = {};
    if (kind === "aggregate-missing") delete r.execution;
    if (kind === "aggregate-null") r.execution = null;
    if (kind === "receipt-id") delete last.actionId;
    if (kind === "duplicate-id") last.actionId = r.receipts[0].actionId;
    const { session, first } = await saved(r);
    const error = await submit(session).catch((e) => e);
    expect(error.message).toBe("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
    expect(error.relatedCommandId).toBe(first.commandId);
    expect((await commands.observe(first.commandId)).result).toMatchObject({
      nativeActionFence: { state: "uncertain" },
    });
  });
  it("keeps legacy partial receipts fenced without inventing worker proof", async () => {
    const { session, first } = await saved(partial());
    await db.query(
      "UPDATE browser_commands SET safe_result=safe_result-'nativeActionFence' WHERE id=$1",
      [first.commandId],
    );
    await expect(submit(session)).rejects.toThrow("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
  });
  it.each([{}, { execution: null }, { execution: "forward-version" }])(
    "fences unclassified legacy aggregate %j",
    async (aggregate) => {
      const { session, first } = await saved(partial());
      await db.query("UPDATE browser_commands SET safe_result=$2::jsonb WHERE id=$1", [
        first.commandId,
        JSON.stringify({ ...aggregate, receipts: [{ execution: "completed" }] }),
      ]);
      await expect(submit(session)).rejects.toThrow("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
    },
  );
  it("rechecks an already queued successor at claim time after uncertainty appears", async () => {
    const session = await seedSession(db, effects, "https://fixture.example");
    const first = await submit(session),
      second = await submit(session);
    const claim = await commands.claim(first.commandId);
    await commands.checkpointAction(first.commandId, claim!.claim_token!, {
      execution: "unknown",
      businessOutcome: "unknown",
      reason: "dispatch_started",
    });
    await commands.fail(
      first.commandId,
      claim!.claim_token!,
      Error("SCRY_BROWSER_ADAPTER_TIMEOUT"),
    );
    const claimed = await Promise.all([
      commands.claim(second.commandId),
      commands.claim(second.commandId),
    ]);
    expect(claimed).toEqual([null, null]);
    expect(await commands.observe(second.commandId)).toMatchObject({
      state: "failed",
      result: { execution: "not_dispatched", reason: "prior_uncertain_action" },
    });
    expect((await commands.observe(first.commandId)).result?.execution).toBe("unknown");
  });
  it("returns the same incident through recovery status without leaking it across workspaces", async () => {
    const { session, first } = await saved({
      execution: "unknown",
      businessOutcome: "unknown",
      reason: "dispatch_started",
    });
    const row = (
      await db.query(
        "SELECT s.run_id,p.workspace_id FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1",
        [session],
      )
    ).rows[0];
    if (!row) throw Error("ISOLATED_FIXTURE_ROW_MISSING");
    const dashboard = new BrowserDashboardRepository(db);
    const status = runRecoveryStatus(await dashboard.recoveryStatus(row.workspace_id, row.run_id));
    expect(status.recovery).toMatchObject({
      incidentId: "scry-command-" + first.commandId,
      relatedCommandId: first.commandId,
      mutationsAllowed: false,
    });
    expect(status.recovery?.admissionAllowedTools).not.toContain("browser_click");
    await expect(dashboard.recoveryStatus(randomUUID(), row.run_id)).rejects.toThrow(
      "SCRY_BROWSER_RUN_NOT_FOUND",
    );
  });
  it.each([
    { execution: "completed", receipts: [] },
    { execution: "tool_error", receipts: [] },
    { execution: "not_dispatched", businessOutcome: "not_dispatched", reason: "dispatch_started" },
    { execution: "not_dispatched", businessOutcome: "unverified" },
  ])(
    "fences contradictory native truth before and without persisted classification: %j",
    async (result) => {
      const { session, first } = await saved(result);
      await expect(submit(session)).rejects.toThrow("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
      await db.query(
        "UPDATE browser_commands SET safe_result=safe_result-'nativeActionFence' WHERE id=$1",
        [first.commandId],
      );
      await expect(submit(session)).rejects.toThrow("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED");
    },
  );
  it("preserves stop access while refusing later actions after an unknown effect", async () => {
    const { session } = await saved({ execution: "unknown", businessOutcome: "unknown" });
    const stopped = await commands.submit(session, {
      idempotencyKey: randomUUID(),
      command: { kind: "close_for_failure" },
    });
    expect(stopped.state).toBe("queued");
    await expect(submit(session)).rejects.toThrow("SCRY_BROWSER_COMMAND_STOP_REQUESTED");
  });
});
