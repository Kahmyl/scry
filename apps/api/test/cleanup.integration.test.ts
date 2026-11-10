import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import { CleanupService } from "../src/test-resources/cleanup.service.js";
import { ProviderDeferred } from "../src/test-resources/provider-http.js";
import { cleanupDecisionSchema } from "@scry/contracts";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(url ? describe : describe.skip)("cleanup lifecycle and retention isolation", () => {
  let db: Database,
    commands: BrowserCommandRepository,
    resources: TestResourcesRepository,
    service: TestResourcesService,
    cleanup: CleanupService;
  const close = vi.fn(async () => {}),
    provision = vi.fn(async (_kind: string, id: string, state: any) => ({
      address: `${id}@fixture.test`,
      privateData: state,
    }));
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(db, cipher);
    resources = new TestResourcesRepository(db, cipher);
    service = new TestResourcesService(
      resources,
      {
        capabilities: () => ({ mailbox: true, webhook: true }),
        prepareMail: async (id: string) => id + "@fixture.test",
        provision,
        close,
        connectMailbox: async (state: any) => ({ address: state.address, privateData: state }),
      } as any,
      commands,
    );
    cleanup = new CleanupService(resources, service);
  });
  afterAll(() => db?.onModuleDestroy());
  async function setup() {
    const sessionId = await seedSession(
      db,
      new BrowserExecutionRepository(db, new BrowserProtectedValueCipher()),
      "https://cleanup.fixture.test",
    );
    const s = (
      await db.query<any>(
        'SELECT s.run_id AS "runId",s.mission_id AS "missionId",s.project_id AS "projectId",p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1',
        [sessionId],
      )
    ).rows[0]!;
    await db.query("UPDATE runs SET state='running' WHERE id=$1", [s.runId]);
    return { ...s, sessionId };
  }
  const decision = (
    kind: "resource" | "credential",
    itemId: string,
    value = "retain",
    more: Record<string, unknown> = {},
  ) =>
    cleanupDecisionSchema.parse({
      kind,
      itemId,
      decision: value,
      reason: "testing_finished",
      confirmed: true,
      idempotencyKey: randomUUID(),
      ...more,
    });
  async function resource(s: any) {
    return service.create(s.workspaceId, s.missionId, {
      kind: "mailbox",
      name: "Fictional inbox",
      idempotencyKey: randomUUID(),
      expiresInSeconds: 3600,
    });
  }
  it("shows pending cleanup, retains only explicit choices and never returns secret values", async () => {
    const s = await setup(),
      r = await resource(s);
    let l = await cleanup.list(s.workspaceId, s.missionId);
    expect(l.complete).toBe(false);
    expect(l.items[0].cleanupStatus).toBe("decision_required");
    l = await cleanup.decide(s.workspaceId, s.missionId, decision("resource", r.id));
    expect(l.complete).toBe(true);
    expect(l.items[0].cleanupStatus).toBe("retained");
    expect(JSON.stringify(l)).not.toMatch(/private_data|ciphertext|passwordCredential/);
  });
  it("does not treat expired external resources as confirmed cleanup", async () => {
    const s = await setup(),
      r = await resource(s);
    await db.query("UPDATE test_resources SET expires_at=now()-interval '1 second' WHERE id=$1", [
      r.id,
    ]);
    expect((await cleanup.list(s.workspaceId, s.missionId)).complete).toBe(false);
  });
  it("closes the same owned resource and preserves observed inventory", async () => {
    const s = await setup(),
      r = await resource(s),
      input = decision("resource", r.id, "close");
    expect((await cleanup.decide(s.workspaceId, s.missionId, input)).items[0]).toMatchObject({
      id: r.id,
      state: "closed",
      cleanupStatus: "ended",
    });
    expect((await cleanup.decide(s.workspaceId, s.missionId, input)).complete).toBe(true);
    expect(await resources.list(s.workspaceId, s.missionId)).toHaveLength(1);
  });
  it("retains pending provider cleanup and resumes exact intent without allocating again", async () => {
    const s = await setup(),
      r = await resource(s),
      input = decision("resource", r.id, "close"),
      before = provision.mock.calls.length;
    close.mockRejectedValueOnce(new ProviderDeferred(2));
    const pending = await cleanup.decide(s.workspaceId, s.missionId, input);
    expect(pending.complete).toBe(false);
    expect(pending.items[0]).toMatchObject({
      state: "closing",
      decision: "close",
      cleanupStatus: "pending",
    });
    expect((await cleanup.decide(s.workspaceId, s.missionId, input)).complete).toBe(true);
    expect(provision.mock.calls.length).toBe(before);
  });
  it("rejects foreign workspaces and item IDs before changing intent", async () => {
    const s = await setup(),
      r = await resource(s);
    await expect(cleanup.list(randomUUID(), s.missionId)).rejects.toThrow("TEST_MISSION_NOT_FOUND");
    await expect(
      cleanup.decide(s.workspaceId, s.missionId, decision("resource", randomUUID(), "close")),
    ).rejects.toThrow("CLEANUP_ITEM_NOT_FOUND");
    expect((await resources.resource(s.workspaceId, r.id)).state).toBe("ready");
  });
  it("same key replays, changed semantics conflict and concurrent duplicates retain one decision", async () => {
    const s = await setup(),
      r = await resource(s),
      input = decision("resource", r.id);
    await Promise.all([
      cleanup.decide(s.workspaceId, s.missionId, input),
      cleanup.decide(s.workspaceId, s.missionId, input),
    ]);
    expect(
      (await db.query("SELECT 1 FROM mission_cleanup_decisions WHERE mission_id=$1", [s.missionId]))
        .rowCount,
    ).toBe(1);
    await expect(
      cleanup.decide(s.workspaceId, s.missionId, { ...input, decision: "close" }),
    ).rejects.toThrow("CLEANUP_IDEMPOTENCY_CONFLICT");
  });
  it("shared selected credentials can be retained but never revoked", async () => {
    const s = await setup(),
      c = await commands.createProtectedInput(s.workspaceId, {
        projectId: s.projectId,
        displayName: "Shared credential",
        value: "fictional-shared-secret",
        expiresInSeconds: 3600,
        idempotencyKey: randomUUID(),
      });
    await commands.bindProtectedInputs(s.workspaceId, s.runId, [c.protectedValueId]);
    await expect(
      cleanup.decide(
        s.workspaceId,
        s.missionId,
        decision("credential", c.protectedValueId, "revoke"),
      ),
    ).rejects.toThrow("CLEANUP_SHARED_CREDENTIAL_RETAINED");
    const l = await cleanup.decide(
      s.workspaceId,
      s.missionId,
      decision("credential", c.protectedValueId, "retain", { reason: "shared_preexisting" }),
    );
    expect(l.items[0]).toMatchObject({
      ownership: "shared_preexisting",
      allowedDecisions: ["retain"],
      cleanupStatus: "retained",
    });
    expect(JSON.stringify(l)).not.toContain("fictional-shared-secret");
  });
  it("Mission-created references cannot be revoked while bound work is active", async () => {
    const s = await setup(),
      c = await commands.createProtectedInput(s.workspaceId, {
        projectId: s.projectId,
        displayName: "Mission code",
        value: "fictional-code",
        expiresInSeconds: 3600,
        idempotencyKey: randomUUID(),
      });
    await db.query("UPDATE protected_values SET mission_id=$2 WHERE id=$1", [
      c.protectedValueId,
      s.missionId,
    ]);
    await commands.bindProtectedInputs(s.workspaceId, s.runId, [c.protectedValueId]);
    const input = decision("credential", c.protectedValueId, "revoke");
    await expect(cleanup.decide(s.workspaceId, s.missionId, input)).rejects.toThrow(
      "CLEANUP_CREDENTIAL_IN_USE",
    );
    await db.query(
      "UPDATE browser_execution_sessions SET state='failed',terminal_at=now() WHERE id=$1",
      [s.sessionId],
    );
    const l = await cleanup.decide(s.workspaceId, s.missionId, input);
    expect(l.items[0]).toMatchObject({ state: "revoked", cleanupStatus: "ended" });
  });
  it("customer mailbox cleanup disconnects locally and retains its shared password", async () => {
    const s = await setup(),
      c = await commands.createProtectedInput(s.workspaceId, {
        projectId: s.projectId,
        displayName: "Mailbox password",
        value: "fictional-mail-password",
        expiresInSeconds: 3600,
        idempotencyKey: randomUUID(),
      });
    const r = await service.connect(s.workspaceId, s.missionId, {
        address: "owned@fixture.test",
        passwordCredentialId: c.protectedValueId,
        name: "Customer inbox",
        expiresInSeconds: 3600,
        idempotencyKey: randomUUID(),
      }),
      before = close.mock.calls.length;
    const l = await cleanup.decide(s.workspaceId, s.missionId, decision("resource", r.id, "close"));
    expect(close.mock.calls.length).toBe(before);
    expect(l.items.find((i) => i.id === c.protectedValueId)).toMatchObject({
      state: "active",
      ownership: "shared_preexisting",
      cleanupStatus: "decision_required",
    });
  });
});
