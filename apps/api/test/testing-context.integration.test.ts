import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { TestingContextController } from "../src/test-resources/testing-context.controller.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { testingContextRequestSchema, createTestResourceSchema } from "@scry/contracts";
import { seedSession } from "./fixtures/browser-session.js";
const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)("context prerequisite snapshots", () => {
  let db: Database,
    controller: TestingContextController,
    commands: BrowserCommandRepository,
    resources: TestResourcesRepository;
  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", target!);
    vi.stubEnv("SCRY_BROWSER_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", "1000");
    vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    commands = new BrowserCommandRepository(db, cipher);
    resources = new TestResourcesRepository(db, cipher);
    controller = new TestingContextController(db, {
      capabilities: () => ({ mailbox: true, webhook: false }),
    } as never);
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    vi.unstubAllEnvs();
  });
  // Strip the fixture's workspace metadata before strict contract validation.
  async function setup() {
    const session = await seedSession(
      db,
      new BrowserExecutionRepository(db, new BrowserProtectedValueCipher()),
      "https://fixture.example",
    );
    const s = (
      await db.query<any>(
        'SELECT s.project_id AS "projectId",s.mission_id AS "missionId",s.environment_id AS "environmentId",p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1',
        [session],
      )
    ).rows[0];
    const { workspaceId, ...ids } = s;
    return {
      s,
      principal: {
        kind: "user" as const,
        subject: "fixture",
        userId: randomUUID(),
        workspaceId,
        role: "member" as const,
        email: "fixture@example.test",
      },
      input: testingContextRequestSchema.parse({ ...ids, required: ["browser"] }),
    };
  }
  it("does not infer mailbox readiness from provider configuration and refuses foreign Projects", async () => {
    const f = await setup();
    const r = await controller.context(f.principal, {
      ...f.input,
      intent: {
        kind: "change_access",
        restoration: { strategy: "received_link", preservesAdministrator: true },
      },
    });
    expect(r.ready).toBe(false);
    expect(r.blocked).toContain("mailboxRead");
    await expect(
      controller.context({ ...f.principal, workspaceId: randomUUID() }, f.input),
    ).rejects.toThrow("PROJECT_NOT_FOUND");
  });
  it("a blocked optional credential read does not strand an independent browser task", async () => {
    const f = await setup(),
      lock = await db.pool.connect();
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE protected_values IN ACCESS EXCLUSIVE MODE");
    const start = performance.now();
    try {
      const r = await controller.context(f.principal, f.input);
      expect(r.ready).toBe(true);
      expect((r as any).parts.credentials.status).toBe("unavailable");
      expect(performance.now() - start).toBeLessThan(1800);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });
  it("an expired customer mailbox credential invalidates a cached Ready resource", async () => {
    const f = await setup();
    const credential = await commands.createProtectedInput(f.s.workspaceId, {
      projectId: f.s.projectId,
      displayName: "Fictional mailbox",
      value: "fictional-mailbox-password",
      expiresInSeconds: 60,
      idempotencyKey: randomUUID(),
    });
    const resource = await resources.allocate(
      f.s.workspaceId,
      f.s.missionId,
      createTestResourceSchema.parse({
        kind: "mailbox",
        name: "Fictional mailbox",
        idempotencyKey: randomUUID(),
      }),
      { address: "fixture@example.test", passwordCredentialId: credential.protectedValueId },
    );
    const lease = await resources.claim(resource);
    await resources.ready(resource.id, lease!, "fixture@example.test", {
      accountId: "fictional-account",
    });
    await resources.release(resource.id, lease!);
    await db.query("UPDATE protected_values SET expires_at=now()-interval '1 second' WHERE id=$1", [
      credential.protectedValueId,
    ]);
    const r = await controller.context(f.principal, {
      ...f.input,
      intent: {
        kind: "change_access",
        restoration: { strategy: "received_link", preservesAdministrator: true },
      },
    });
    expect(r.ready).toBe(false);
    expect(r.blocked).toContain("mailboxRead");
  });
  it("a viewer's preflight refuses live actions while allowing independent cached inspection", async () => {
    const f = await setup();
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V1_ENABLED", "true");
    vi.stubEnv("SCRY_BROWSER_WORKFLOW_V2_ENABLED", "true");
    const r = await controller.context(
      { ...f.principal, role: "viewer" },
      {
        ...f.input,
        required: ["browser", "journey", "apiRequests", "finalize", "release"],
      },
    );
    expect(r.ready).toBe(false);
    expect(r.blocked).toEqual(
      expect.arrayContaining([
        "workspace_read_only",
        "browser",
        "journey",
        "apiRequests",
        "finalize",
        "release",
      ]),
    );
    expect(r.capabilities.features.browser).toMatchObject({
      supported: true,
      configured: true,
      available: false,
    });
    expect(r.hostToolExposure).toBe("unknown");
  });
});
