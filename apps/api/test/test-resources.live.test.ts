import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { seedSession } from "./fixtures/browser-session.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { TestResourceProviders } from "../src/test-resources/providers.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import { withProviderBudget } from "../src/test-resources/provider-http.js";

// Explicit opt-in only: creates and closes fictional resources at real providers.
// Never run against the deployed Scry database or use real customer payloads.
const live = process.env.SCRY_TEST_RESOURCES_LIVE === "true";
if (live) process.loadEnvFile(new URL("../../../.env.test-resources.local", import.meta.url));
(live ? describe : describe.skip)("live disposable provider qualification", () => {
  let db: Database, service: TestResourcesService, session: string;
  let scope: { workspaceId: string; missionId: string };
  beforeAll(async () => {
    const target = new URL(process.env.SCRY_BROWSER_TEST_DATABASE_URL!);
    if (
      !["127.0.0.1", "localhost"].includes(target.hostname) ||
      !target.pathname.includes("scry_test_resources")
    )
      throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
    process.env.DATABASE_URL = target.href;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    db = new Database();
    const cipher = new BrowserProtectedValueCipher();
    service = new TestResourcesService(
      new TestResourcesRepository(db, cipher),
      new TestResourceProviders(db),
      new BrowserCommandRepository(db, cipher),
    );
    // Reconcile only previous fixtures created by this explicit live suite.
    // Older trial closure disabled delivery, not the receiving source itself.
    if (process.env.HOOKDECK_API_KEY) {
      const previous = await db.query<{ id: string }>(
        "SELECT id FROM test_resources WHERE kind='webhook' AND name='Live order callback qualification'",
      );
      for (const fixture of previous.rows) {
        const name = `scry-${fixture.id}`;
        const headers = { authorization: `Bearer ${process.env.HOOKDECK_API_KEY}` };
        const listed = await service.providers.hookdeck.request(
          `/sources?name=${encodeURIComponent(name)}&limit=100`,
          { headers },
        );
        for (const source of listed.data.models ?? []) {
          if (source.name === name && typeof source.id === "string")
            await service.providers.hookdeck.request(
              `/sources/${encodeURIComponent(source.id)}/disable`,
              { method: "PUT", headers },
              [404],
            );
        }
      }
    }
    session = await seedSession(
      db,
      new BrowserExecutionRepository(db, cipher),
      "https://fixture.example",
    );
    scope = (
      await db.query<{ workspaceId: string; missionId: string }>(
        `SELECT p.workspace_id AS "workspaceId",s.mission_id AS "missionId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
        [session],
      )
    ).rows[0]!;
  }, 30000);
  afterAll(async () => {
    if (session)
      await db.query(
        "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
        [session],
      );
    await db?.onModuleDestroy();
  });
  it("creates, privately authenticates, polls and closes an actual Mail.tm inbox", async () => {
    const resource = await withProviderBudget(() =>
      service.create(scope.workspaceId, scope.missionId, {
        kind: "mailbox",
        name: "Live inbox qualification",
        idempotencyKey: randomUUID(),
        expiresInSeconds: 3600,
      }),
    );
    try {
      expect(resource.state).toBe("ready");
      expect(resource.address).toContain("@");
      const receipt = await withProviderBudget(() =>
        service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
      );
      expect(receipt.status).toBe("waiting");
      expect(JSON.stringify(receipt)).not.toMatch(/password|Bearer /);
      // Reuse this disposable fixture as an existing customer mailbox. No real
      // user's saved mailbox credential or historical email is involved.
      const row = await service.repository.resource(scope.workspaceId, resource.id);
      const state = service.repository.open<{ password: string }>(row.private_data, row.id);
      const selected = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: row.projectId,
        displayName: "Fictional existing Mail.tm password",
        value: state.password,
        expiresInSeconds: null,
        idempotencyKey: randomUUID(),
      });
      const connected = await withProviderBudget(() =>
        service.connect(scope.workspaceId, scope.missionId, {
          name: "Existing mailbox qualification",
          address: resource.address!,
          passwordCredentialId: selected.protectedValueId,
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
      );
      try {
        expect(connected.ownership).toBe("customer");
        expect(connected.state).toBe("ready");
        expect(
          (
            await withProviderBudget(() =>
              service.read(scope.workspaceId, connected.id, { waitSeconds: 0 }),
            )
          ).status,
        ).toBe("waiting");
      } finally {
        expect((await service.close(scope.workspaceId, connected.id)).state).toBe("closed");
      }
      // The original login still works after disconnecting the customer path.
      expect(
        (
          await withProviderBudget(() =>
            service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
          )
        ).status,
      ).toBe("waiting");
    } finally {
      expect(
        (await withProviderBudget(() => service.close(scope.workspaceId, resource.id))).state,
      ).toBe("closed");
    }
    // Outbound delivery is a separate check requiring an authorized sender.
  }, 90000);
  it.skipIf(!process.env.HOOKDECK_API_KEY)(
    "captures a real Hookdeck callback, protects its code and disables reception",
    async () => {
      const resource = await withProviderBudget(() =>
        service.create(scope.workspaceId, scope.missionId, {
          kind: "webhook",
          name: "Live order callback qualification",
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
      );
      try {
        expect(resource.state).toBe("ready");
        const posted = await fetch(resource.address!, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fictional_qualification_secret",
          },
          body: JSON.stringify({
            orderNumber: 4477,
            event: "order.created",
            verification_code: "942781",
          }),
        });
        expect(posted.ok).toBe(true);
        await posted.body?.cancel();
        let receipt = await withProviderBudget(() =>
          service.read(scope.workspaceId, resource.id, { waitSeconds: 15 }),
        );
        expect(receipt.status).toBe("received");
        expect(receipt.events).toHaveLength(1);
        expect(JSON.stringify(receipt.events)).toContain("4477");
        expect(JSON.stringify(receipt.events)).not.toContain("942781");
        expect(JSON.stringify(receipt.events)).not.toContain("fictional_qualification_secret");
        const repeated = await withProviderBudget(() =>
          service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
        );
        expect(repeated.events.map((e) => e.id)).toEqual(receipt.events.map((e) => e.id));
      } finally {
        expect(
          (await withProviderBudget(() => service.close(scope.workspaceId, resource.id))).state,
        ).toBe("closed");
        const row = await service.repository.resource(scope.workspaceId, resource.id);
        const state = service.repository.open<{ sourceId: string }>(row.private_data, resource.id);
        const result = await service.providers.hookdeck.request(
          `/sources/${encodeURIComponent(state.sourceId)}`,
          { headers: { authorization: `Bearer ${process.env.HOOKDECK_API_KEY}` } },
        );
        expect(Number.isFinite(Date.parse(result.data.disabled_at))).toBe(true);
      }
    },
    90000,
  );
});
