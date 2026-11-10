import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { seedSession } from "./fixtures/browser-session.js";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)("authoritative workflow admission and cancellation", () => {
  let db: Database,
    commands: BrowserCommandRepository,
    execution: BrowserExecutionRepository,
    lifecycle: BrowserLifecycleRepository;
  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", target!);
    vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V1_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(db, cipher);
    execution = new BrowserExecutionRepository(db, cipher);
    lifecycle = new BrowserLifecycleRepository(db, new BrowserRuntimeVeilReportProtection());
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    vi.unstubAllEnvs();
  });
  async function fixture() {
    const session = await seedSession(db, execution, "https://fixture.example");
    const scope = (
      await db.query<{ workspaceId: string; runId: string }>(
        'SELECT p.workspace_id AS "workspaceId",s.run_id AS "runId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1',
        [session],
      )
    ).rows[0]!;
    return { session, ...scope };
  }
  const plan = () => ({
    kind: "browser_tool" as const,
    tool: "browser_sequence",
    args: {
      planId: randomUUID(),
      observationId: randomUUID(),
      steps: [
        {
          tool: "browser_type",
          actionId: randomUUID(),
          args: { target: "e1", text: "Fictional entry" },
        },
      ],
    },
  });
  const ordinary = () => ({
    kind: "browser_tool" as const,
    tool: "browser_click",
    args: { target: "e2" },
  });
  it("admits a whole plan as one encrypted command and orders ordinary commands behind it", async () => {
    const f = await fixture(),
      input = { idempotencyKey: randomUUID(), command: plan() };
    const pending = commands.submit(f.session, input);
    input.command.args.steps[0]!.args.text = "Changed during await";
    const submitted = await pending,
      after = await commands.submit(f.session, {
        idempotencyKey: randomUUID(),
        command: ordinary(),
      });
    await expect(commands.claim(after.commandId)).rejects.toThrow("PREDECESSOR_PENDING");
    const claimed = await commands.claim(submitted.commandId);
    expect(claimed!.execution_budget_ms).toBe(25000);
    expect((claimed!.safe_input as any).args.steps[0].args.text).toBe("Fictional entry");
    const persisted = (
      await db.query("SELECT safe_input FROM browser_commands WHERE id=$1", [submitted.commandId])
    ).rows[0];
    expect(JSON.stringify(persisted)).not.toContain("Fictional entry");
  });
  it("stop is scoped, cancels queued work, refuses later dispatch but permits emergency close", async () => {
    const f = await fixture(),
      first = await commands.submit(f.session, { idempotencyKey: randomUUID(), command: plan() }),
      second = await commands.submit(f.session, {
        idempotencyKey: randomUUID(),
        command: ordinary(),
      });
    const claim = await commands.claim(first.commandId);
    const token = claim!.claim_token!;
    await commands.checkpointAction(first.commandId, token, {
      execution: "unknown",
      reason: "dispatch_started",
      receipts: [{ actionId: "fictional-step", execution: "unknown" }],
    });
    await expect(commands.requestStop(f.session, randomUUID())).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
    expect(await commands.requestStop(f.session, f.workspaceId)).toMatchObject({
      stopRequested: true,
      inFlight: true,
      browserReleased: false,
    });
    expect((await commands.observe(second.commandId)).state).toBe("failed");
    await expect(commands.assertClaim(first.commandId, token)).rejects.toThrow("STOP_REQUESTED");
    await expect(
      commands.checkpointAction(first.commandId, token, {
        execution: "unknown",
        reason: "dispatch_started",
      }),
    ).rejects.toThrow("STOP_REQUESTED");
    await commands.checkpointAction(first.commandId, token, {
      execution: "unknown",
      reason: "step_receipt",
      receipts: [{ actionId: "fictional-step", execution: "completed" }],
    });
    await commands.fail(first.commandId, token, new Error("SCRY_BROWSER_COMMAND_STOP_REQUESTED"));
    await expect(
      commands.submit(f.session, { idempotencyKey: randomUUID(), command: ordinary() }),
    ).rejects.toThrow("STOP_REQUESTED");
    const close = await commands.submit(f.session, {
      idempotencyKey: randomUUID(),
      command: { kind: "close_for_failure" },
    });
    expect((await commands.claim(close.commandId))?.safe_input.kind).toBe("close_for_failure");
  });
  it("quarantines uncertain effects including commands queued before uncertainty was known", async () => {
    const f = await fixture(),
      first = await commands.submit(f.session, { idempotencyKey: randomUUID(), command: plan() }),
      second = await commands.submit(f.session, {
        idempotencyKey: randomUUID(),
        command: ordinary(),
      });
    const claim = await commands.claim(first.commandId);
    await commands.checkpointAction(first.commandId, claim!.claim_token!, {
      execution: "unknown",
      reason: "dispatch_started",
    });
    await commands.fail(
      first.commandId,
      claim!.claim_token!,
      new Error("fictional lost acknowledgement"),
    );
    expect(await commands.claim(second.commandId)).toBeNull();
    expect((await commands.observe(second.commandId)).result).toMatchObject({
      execution: "not_dispatched",
    });
    await expect(
      commands.submit(f.session, { idempotencyKey: randomUUID(), command: ordinary() }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
    const read = await commands.submit(f.session, {
      idempotencyKey: randomUUID(),
      command: { kind: "browser_tool", tool: "browser_snapshot", args: {} },
    });
    expect((await commands.claim(read.commandId))?.safe_input.kind).toBe("browser_tool");
    const owner = await execution.claimOwner(f.session, "metadata-fixture", 60000);
    await expect(execution.finalizeSession(f.session, owner.generation)).rejects.toThrow(
      "NATIVE_OUTCOME_UNKNOWN",
    );
  });
  it("closure admission prevents new application work while exact receipts remain readable", async () => {
    const f = await fixture(),
      input = { idempotencyKey: randomUUID(), command: ordinary() };
    const first = await commands.submit(f.session, input);
    await commands.submit(f.session, {
      idempotencyKey: randomUUID(),
      command: { kind: "close_for_failure" },
    });
    expect((await commands.submit(f.session, input)).commandId).toBe(first.commandId);
    await expect(
      commands.submit(f.session, { idempotencyKey: randomUUID(), command: ordinary() }),
    ).rejects.toThrow("STOP_REQUESTED");
  });
  it("normalizes PostgreSQL generation values and disables new plans before persistence when not enabled", async () => {
    const f = await fixture();
    expect(
      typeof (await lifecycle.executionSessionForRun(f.workspaceId, f.runId)).ownerGeneration,
    ).toBe("number");
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V1_ENABLED", "false");
    try {
      await expect(
        commands.submit(f.session, { idempotencyKey: randomUUID(), command: plan() }),
      ).rejects.toThrow("WORKFLOW_DISABLED");
    } finally {
      vi.stubEnv("SCRY_BROWSER_WORKFLOW_V1_ENABLED", "true");
    }
    expect(
      (
        await db.query("SELECT count(*)::int AS n FROM browser_commands WHERE session_id=$1", [
          f.session,
        ])
      ).rows[0]!.n,
    ).toBe(0);
  });
  it("disabled extended capabilities persist no commands while individual controls remain usable", async () => {
    const f = await fixture();
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V2_ENABLED", "false");
    for (const [tool, args] of [
      ["browser_scoped_request", { method: "GET", url: "https://fixture.example/api" }],
      ["browser_list_downloads", {}],
      ["browser_verify_download", { downloadId: randomUUID() }],
      ["browser_set_viewport", { profile: "mobile" }],
    ] as const)
      await expect(
        commands.submit(f.session, {
          idempotencyKey: randomUUID(),
          command: { kind: "browser_tool", tool, args },
        }),
      ).rejects.toThrow("WORKFLOW_DISABLED");
    expect(
      (
        await db.query("SELECT count(*)::int AS n FROM browser_commands WHERE session_id=$1", [
          f.session,
        ])
      ).rows[0]!.n,
    ).toBe(0);
    const ordinaryResult = await commands.submit(f.session, {
      idempotencyKey: randomUUID(),
      command: ordinary(),
    });
    expect(ordinaryResult.commandId).toBeTruthy();
  });
});
