import "reflect-metadata";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import { TestResourceProviders } from "../src/test-resources/providers.js";
import { ProviderDeferred, ProviderHttp } from "../src/test-resources/provider-http.js";
import { VeilBrowserProtection, createNativeAdapterProtector } from "@scry/veil";
import { seedSession } from "./fixtures/browser-session.js";
const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)(
  "browser-generated secret custody and signature receipts",
  () => {
    let db: Database,
      commands: BrowserCommandRepository,
      resources: TestResourcesRepository,
      providers: TestResourceProviders,
      service: TestResourcesService,
      session: string,
      run: string,
      workspace: string,
      mission: string;
    const secret = "fictional-generated-signing-key-837249";
    beforeAll(async () => {
      process.env.DATABASE_URL = target;
      process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
      process.env.SCRY_BROWSER_WORKFLOW_V2_ENABLED = "true";
      process.env.SCRY_BROWSER_ADAPTER = "playwright_mcp";
      process.env.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED = "true";
      db = new Database();
      const cipher = new BrowserProtectedValueCipher();
      commands = new BrowserCommandRepository(db, cipher);
      resources = new TestResourcesRepository(db, cipher);
      providers = new TestResourceProviders(db);
      service = new TestResourcesService(resources, providers, commands);
      session = await seedSession(
        db,
        new BrowserExecutionRepository(db, cipher),
        "https://fixture.example",
      );
      const facts = (
        await db.query(
          "SELECT s.run_id,s.mission_id,p.workspace_id FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1",
          [session],
        )
      ).rows[0]!;
      run = facts.run_id;
      workspace = facts.workspace_id;
      mission = facts.mission_id;
      await db.query("UPDATE runs SET state='running' WHERE id=$1", [run]);
      await new BrowserExecutionRepository(db, cipher).claimOwner(
        session,
        "fictional-secret-owner",
        60000,
      );
    });
    afterAll(async () => {
      if (session)
        await db.query(
          "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
          [session],
        );
      await db?.onModuleDestroy();
    });
    const request = (
      uses: Array<"browser_fill" | "scoped_request" | "hmac_verification"> = ["hmac_verification"],
    ) => ({
      sourceOrigin: "https://fixture.example",
      target: { selector: "code" },
      displayName: "Fictional test signing key",
      permittedUses: uses,
      expiresInSeconds: 3600,
      trimWhitespace: false,
      userConfirmed: true as const,
    });
    async function prepare(uses?: Array<"browser_fill" | "scoped_request" | "hmac_verification">) {
      const input = request(uses),
        submitted = await commands.submit(session, {
          command: { kind: "browser_tool", tool: "browser_capture_secret", args: input },
          idempotencyKey: randomUUID(),
        });
      const claimed = (await commands.claim(submitted.commandId))!;
      const scope = await commands.sessionContext(session);
      const capture = new VeilBrowserProtection().nativeSecretCapture(
        scope,
        input,
        submitted.commandId,
        scope.environmentId,
      );
      const value = capture.accept(
        createNativeAdapterProtector({}).sealGeneratedSecret(secret, capture.request),
      );
      return { submitted, claimed, value };
    }
    async function save(uses?: Array<"browser_fill" | "scoped_request" | "hmac_verification">) {
      const p = await prepare(uses);
      const metadata = await commands.saveGeneratedSecret(
        p.submitted.commandId,
        p.claimed.claim_token!,
        p.value,
      );
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "completed",
        businessOutcome: "not_dispatched",
        observation: "available",
        protectedReferences: [metadata],
        content: [],
      });
      return metadata;
    }
    it("atomically saves one scoped reference with a durable recovery checkpoint", async () => {
      const p = await prepare(["browser_fill", "scoped_request", "hmac_verification"]);
      const results = await Promise.all([
        commands.saveGeneratedSecret(p.submitted.commandId, p.claimed.claim_token!, p.value),
        commands.saveGeneratedSecret(p.submitted.commandId, p.claimed.claim_token!, p.value),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(JSON.stringify(results)).not.toContain(secret);
      const stored = (
        await db.query(
          "SELECT source_kind,native_source_command_id,mission_id,source_effect_id,ciphertext FROM protected_values WHERE id=$1",
          [results[0]!.protectedValueId],
        )
      ).rows[0]!;
      expect(stored).toMatchObject({
        source_kind: "browser_generated",
        native_source_command_id: p.submitted.commandId,
        mission_id: mission,
        source_effect_id: null,
      });
      expect(stored.ciphertext.toString()).not.toContain(secret);
      const receipt = await commands.observe(p.submitted.commandId);
      expect(receipt.result?.protectedReferences).toHaveLength(1);
      expect(
        await commands.protectedValueForBrowser(
          session,
          results[0]!.protectedValueId,
          "scoped_request",
        ),
      ).toBe(secret);
      expect(Object.values(await commands.protectedValuesForSession(session))).toContain(secret);
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, receipt.result!);
    });
    it("waits on Session coordination before locking the Command, avoiding the stop/claim lock inversion", async () => {
      const p = await prepare(),
        blocker = await db.pool.connect();
      let pending: ReturnType<typeof commands.saveGeneratedSecret> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM browser_execution_sessions WHERE id=$1 FOR UPDATE", [
          session,
        ]);
        pending = commands.saveGeneratedSecret(
          p.submitted.commandId,
          p.claimed.claim_token!,
          p.value,
        );
        void pending.catch(() => {});
        await expect
          .poll(async () =>
            Number(
              (
                await db.query(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT s.id FROM browser_commands%' ",
                )
              ).rows[0]!.n,
            ),
          )
          .toBe(1);
        await db.transaction(async (c) => {
          await c.query("SELECT id FROM browser_commands WHERE id=$1 FOR UPDATE NOWAIT", [
            p.submitted.commandId,
          ]);
        });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      const metadata = await pending!;
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "completed",
        businessOutcome: "not_dispatched",
        observation: "available",
        protectedReferences: [metadata],
        content: [],
      });
    });
    it("rejects a stale claim without partially storing a credential", async () => {
      const p = await prepare();
      await expect(
        commands.saveGeneratedSecret(p.submitted.commandId, randomUUID(), p.value),
      ).rejects.toThrow("CLAIM_FENCED");
      expect(
        (
          await db.query("SELECT id FROM protected_values WHERE native_source_command_id=$1", [
            p.submitted.commandId,
          ])
        ).rowCount,
      ).toBe(0);
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        observation: "unavailable",
        content: [],
      });
    });
    it("rejects altered command intent, Environment and owner provenance without partial admission", async () => {
      const p = await prepare();
      for (const metadata of [
        { ...p.value.metadata, environmentId: randomUUID() },
        { ...p.value.metadata, sourceOwnerGeneration: 2 },
        { ...p.value.metadata, permittedUses: ["browser_fill" as const] },
      ]) {
        await expect(
          commands.saveGeneratedSecret(p.submitted.commandId, p.claimed.claim_token!, {
            ...p.value,
            metadata,
          }),
        ).rejects.toThrow("PROTECTED_VALUE_UNAVAILABLE");
      }
      expect(
        (
          await db.query("SELECT id FROM protected_values WHERE native_source_command_id=$1", [
            p.submitted.commandId,
          ])
        ).rowCount,
      ).toBe(0);
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        observation: "unavailable",
        content: [],
      });
    });
    it("enforces permitted uses, expiry, Scry revocation and workspace metadata scope", async () => {
      const m = await save(["hmac_verification"]);
      expect(
        await commands.protectedValueForBrowser(session, m.protectedValueId, "hmac_verification"),
      ).toBe(secret);
      await expect(
        commands.protectedValueForBrowser(session, m.protectedValueId, "scoped_request"),
      ).rejects.toThrow("PROTECTED_VALUE_UNAVAILABLE");
      await expect(commands.listGeneratedSecrets(randomUUID(), run)).rejects.toThrow(
        "RUN_NOT_FOUND",
      );
      await commands.revokeGeneratedSecret(workspace, run, m.protectedValueId);
      expect(
        (await commands.listGeneratedSecrets(workspace, run)).find(
          (item) => item.protectedValueId === m.protectedValueId,
        )?.state,
      ).toBe("revoked");
      await expect(
        commands.protectedValueForBrowser(session, m.protectedValueId, "hmac_verification"),
      ).rejects.toThrow("PROTECTED_VALUE_UNAVAILABLE");
      expect(Object.values(await commands.protectedValuesForSession(session))).toContain(secret);
      const expired = await save(["browser_fill"]);
      await db.query(
        "UPDATE protected_values SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired.protectedValueId],
      );
      await expect(
        commands.protectedValueForBrowser(session, expired.protectedValueId),
      ).rejects.toThrow("PROTECTED_VALUE_UNAVAILABLE");
    });
    it("rolls back credential, binding and checkpoint together when durable checkpointing fails", async () => {
      const p = await prepare();
      await db.query(
        `CREATE FUNCTION fixture_reject_generated_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${p.submitted.commandId}'::uuid AND NEW.safe_result IS NOT NULL THEN RAISE EXCEPTION 'FICTIONAL_CHECKPOINT_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await db.query(
        "CREATE TRIGGER fixture_reject_generated_checkpoint BEFORE UPDATE ON browser_commands FOR EACH ROW EXECUTE FUNCTION fixture_reject_generated_checkpoint()",
      );
      try {
        await expect(
          commands.saveGeneratedSecret(p.submitted.commandId, p.claimed.claim_token!, p.value),
        ).rejects.toThrow("FICTIONAL_CHECKPOINT_FAILURE");
        expect(
          (
            await db.query("SELECT id FROM protected_values WHERE native_source_command_id=$1", [
              p.submitted.commandId,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await db.query("DROP TRIGGER fixture_reject_generated_checkpoint ON browser_commands");
        await db.query("DROP FUNCTION fixture_reject_generated_checkpoint()");
      }
      const m = await commands.saveGeneratedSecret(
        p.submitted.commandId,
        p.claimed.claim_token!,
        p.value,
      );
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "completed",
        businessOutcome: "not_dispatched",
        observation: "available",
        protectedReferences: [m],
        content: [],
      });
    });
    it("uses exact provider bytes for one immutable signature receipt, not parsed JSON", async () => {
      const m = await save(["hmac_verification"]),
        body = Buffer.from('{ "event": "fictional" }\n'),
        signature = createHmac("sha256", secret).update(body).digest("hex");
      const row = await resources.allocate(workspace, mission, {
          kind: "webhook",
          name: "Fictional webhook",
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
        lease = (await resources.claim(row))!;
      await resources.ready(row.id, lease, "https://hkdk.events/fictional", {
        sourceId: "src_fixture",
      });
      await resources.record(row, lease, [
        {
          id: "req_fixture",
          receivedAt: new Date().toISOString(),
          title: "Webhook received",
          content: { headers: { "x-fixture-signature": signature }, body: { event: "fictional" } },
        },
      ]);
      await resources.release(row.id, lease);
      const event = (await resources.events(workspace, row.id))[0]!;
      const provider = vi.spyOn(providers, "webhookSignatureReceipt").mockResolvedValue({
        available: true,
        body,
        headers: { "X-Fixture-Signature": signature },
      });
      const input = {
        eventId: event.id,
        runId: run,
        protectedValueId: m.protectedValueId,
        signatureHeader: "x-fixture-signature",
        encoding: "hex" as const,
        prefix: "" as const,
        userConfirmed: true as const,
        idempotencyKey: randomUUID(),
      };
      try {
        const first = await service.verifySignature(workspace, row.id, input);
        expect(first).toMatchObject({
          status: "matched",
          replayProtection: "not_assessed",
          bodyBytes: body.length,
        });
        expect(JSON.stringify(first)).not.toContain(secret);
        expect(JSON.stringify(first)).not.toContain(signature);
        expect(JSON.stringify(first)).not.toContain(body.toString());
        expect(await service.verifySignature(workspace, row.id, input)).toMatchObject({
          status: "matched",
          cached: true,
        });
        expect(provider).toHaveBeenCalledTimes(1);
        await expect(service.verifySignature(randomUUID(), row.id, input)).rejects.toThrow(
          "RESOURCE_NOT_FOUND",
        );
        provider.mockResolvedValue({ available: false });
        expect(
          await service.verifySignature(workspace, row.id, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ).toMatchObject({ status: "unavailable", reason: "exact_raw_body_unavailable" });
        provider.mockRejectedValue(new ProviderDeferred(2, "unavailable"));
        expect(
          await service.verifySignature(workspace, row.id, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ).toMatchObject({ status: "temporarily_unavailable", retryAfterSeconds: 2 });
      } finally {
        provider.mockRestore();
      }
    });
    it("keeps provider raw bodies as bytes and refuses a foreign provider source", async () => {
      const body = Buffer.from([0, 255, 123, 32, 125, 10]);
      const http = new ProviderHttp(
        db,
        "hookdeck",
        "https://fictional.example",
        async () => new Response(body),
      );
      expect((await http.request("/raw", {}, [], "bytes")).data).toEqual(body);
      const request = vi
        .spyOn(providers.hookdeck, "request")
        .mockResolvedValue({ status: 200, data: { id: "req_wrong", source_id: "src_elsewhere" } });
      process.env.HOOKDECK_API_KEY = "fictional-local-key";
      try {
        await expect(
          providers.webhookSignatureReceipt({ sourceId: "src_owned" }, "req_wrong"),
        ).rejects.toThrow("TEST_PROVIDER_SCOPE_INVALID");
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        request.mockRestore();
        delete process.env.HOOKDECK_API_KEY;
      }
    });
    it("refuses admission after owner expiry while preserving the command's prior action truth", async () => {
      const p = await prepare();
      await db.query(
        "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND generation=1",
        [session],
      );
      await expect(
        commands.saveGeneratedSecret(p.submitted.commandId, p.claimed.claim_token!, p.value),
      ).rejects.toThrow("OWNER_FENCED");
      expect(
        (
          await db.query("SELECT id FROM protected_values WHERE native_source_command_id=$1", [
            p.submitted.commandId,
          ])
        ).rowCount,
      ).toBe(0);
      await commands.complete(p.submitted.commandId, p.claimed.claim_token!, {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        observation: "unavailable",
        content: [],
      });
    });
  },
);
