import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { AuthService } from "../src/auth/auth.service.js";
import { IdentityRepository } from "../src/auth/repositories/identity.repository.js";
import { McpTokenRepository } from "../src/auth/repositories/mcp-token.repository.js";
import type { UserPrincipal } from "../src/auth/auth.types.js";
import { TestResourcesController } from "../src/test-resources/test-resources.controller.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { seedSession } from "./fixtures/browser-session.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { TestResourceProviders } from "../src/test-resources/providers.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import {
  ProviderDeferred,
  ProviderHttp,
  withProviderBudget,
} from "../src/test-resources/provider-http.js";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(target ? describe : describe.skip)(
  "mission mailboxes and authenticated Hookdeck listeners",
  () => {
    let db: Database,
      repo: TestResourcesRepository,
      service: TestResourcesService,
      providers: TestResourceProviders;
    let scope: { workspaceId: string; missionId: string; projectId: string; runId: string };
    let sessionId: string;
    const accounts = new Map<string, { id: string; password: string }>();
    const messages = new Map<string, any[]>();
    let creationCalls = 0;
    const response = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers });
    beforeAll(async () => {
      process.env.DATABASE_URL = target;
      process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
      process.env.SCRY_TEST_MAIL_ENABLED = "true";
      process.env.HOOKDECK_API_KEY = "fictional-hookdeck-project-key";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string, init: RequestInit = {}) => {
          const u = new URL(input);
          const body = init.body ? JSON.parse(String(init.body)) : {};
          if (u.hostname === "api.mail.tm") {
            expect((init.headers as Record<string, string>).accept).toBe("application/ld+json");
            if (u.pathname === "/domains")
              return response({
                "hydra:member": [{ domain: "mail.example", isActive: true, isPrivate: false }],
              });
            if (u.pathname === "/accounts") {
              creationCalls++;
              if (accounts.has(body.address)) return response({}, 422);
              accounts.set(body.address, { id: randomUUID(), password: body.password });
              return response({});
            }
            if (u.pathname === "/token") {
              const a = accounts.get(body.address);
              return a && a.password === body.password
                ? response({ id: a.id, token: a.id })
                : response({}, 401);
            }
            const token = (init.headers as Record<string, string>)?.authorization?.replace(
              "Bearer ",
              "",
            );
            const a = [...accounts.entries()].find(([, v]) => v.id === token);
            if (!a) return response({}, 401);
            if (u.pathname === "/me")
              return response({ id: a[1].id, address: a[0], isDeleted: false, isDisabled: false });
            if (u.pathname === "/messages")
              return response({
                "hydra:member": (messages.get(a[0]) ?? []).map((m) => ({ id: m.id })),
                "hydra:totalItems": (messages.get(a[0]) ?? []).length,
              });
            if (u.pathname.startsWith("/messages/"))
              return response(
                (messages.get(a[0]) ?? []).find((m) => m.id === u.pathname.split("/").at(-1)),
              );
            if (u.pathname.startsWith("/accounts/") && init.method === "DELETE") {
              accounts.delete(a[0]);
              return new Response(null, { status: 204 });
            }
          }
          if (u.hostname === "api.hookdeck.com") {
            expect((init.headers as Record<string, string>).authorization).toBe(
              "Bearer fictional-hookdeck-project-key",
            );
            if (u.pathname.endsWith("/connections") && init.method === "PUT")
              return response({
                id: "web_" + body.name,
                source: { id: "src_" + body.name, url: "https://hkdk.events/" + body.name },
              });
            if (u.pathname.endsWith("/requests")) return response({ models: [], count: 0 });
            if (u.pathname.endsWith("/disable")) {
              expect(u.pathname).toContain("/sources/");
              return response({});
            }
          }
          throw new Error("unexpected fixture request");
        }),
      );
      db = new Database();
      const cipher = new BrowserProtectedValueCipher();
      repo = new TestResourcesRepository(db, cipher);
      providers = new TestResourceProviders(db);
      service = new TestResourcesService(repo, providers, new BrowserCommandRepository(db, cipher));
      const session = await seedSession(
        db,
        new BrowserExecutionRepository(db, cipher),
        "https://fixture.example",
      );
      sessionId = session;
      scope = (
        await db.query<any>(
          `SELECT s.run_id AS "runId",s.mission_id AS "missionId",s.project_id AS "projectId",p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
          [session],
        )
      ).rows[0];
      await db.query("UPDATE runs SET state='running' WHERE id=$1", [scope.runId]);
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      if (sessionId)
        await db.query(
          "UPDATE browser_execution_sessions SET state='completed',terminal_at=now() WHERE id=$1",
          [sessionId],
        );
      await db?.onModuleDestroy();
      delete process.env.HOOKDECK_API_KEY;
      delete process.env.SCRY_TEST_MAIL_ENABLED;
    });
    const allocate = (key = randomUUID()) =>
      withProviderBudget(() =>
        service.create(scope.workspaceId, scope.missionId, {
          kind: "mailbox",
          name: "Invitation emails",
          idempotencyKey: key,
          expiresInSeconds: 3600,
        }),
      );

    it("creates one recoverable private mailbox and rejects conflicting idempotency", async () => {
      const key = randomUUID(),
        a = await allocate(key),
        b = await allocate(key);
      expect(a.id).toBe(b.id);
      expect(a.state).toBe("ready");
      expect(a.address).toContain("@mail.example");
      expect(JSON.stringify(a)).not.toContain("password");
      const privateRow = await repo.resource(scope.workspaceId, a.id);
      const privateData = repo.open<{ password: string }>(privateRow.private_data, a.id);
      expect(JSON.stringify(privateRow)).not.toContain(privateData.password);
      await expect(
        service.create(scope.workspaceId, scope.missionId, {
          kind: "mailbox",
          name: "Different intent",
          idempotencyKey: key,
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow("TEST_RESOURCE_IDEMPOTENCY_CONFLICT");
    }, 20000);
    it("never provisions a provider resource for another workspace", async () => {
      const before = creationCalls;
      await expect(
        service.create(randomUUID(), scope.missionId, {
          kind: "mailbox",
          name: "Other",
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow("TEST_MISSION_NOT_FOUND");
      expect(creationCalls).toBe(before);
    });
    it("coordinates concurrent creation without duplicate provider identities or customer errors", async () => {
      const key = randomUUID();
      const results = await Promise.all([allocate(key), allocate(key)]);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.some((r) => r.state === "ready")).toBe(true);
    }, 20000);
    it("captures real-shaped email once, protects its code and binds it only to this mission", async () => {
      const resource = await allocate();
      const a = accounts.get(resource.address!)!;
      messages.set(resource.address!, [
        {
          id: randomUUID(),
          // Actual application/ld+json responses encode this relationship as
          // a relative resource IRI, not the token endpoint's bare account ID.
          accountId: `/accounts/${a.id}`,
          createdAt: new Date().toISOString(),
          subject: "Accept your invitation",
          text: "Your verification code is 654321. Your role is Editor.",
          from: { address: "invites@fixture.example" },
          to: [{ address: resource.address }],
          html: [],
          hasAttachments: false,
        },
      ]);
      const first = await withProviderBudget(() =>
        service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
      );
      const second = await withProviderBudget(() =>
        service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
      );
      expect(first.status).toBe("received");
      expect(first.events).toHaveLength(1);
      expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
      expect(JSON.stringify(first.events)).not.toContain("654321");
      expect(JSON.stringify(first.events)).toContain("Editor");
      const secret = first.events[0]!.secrets[0]!;
      const bound = await service.useSecret(
        scope.workspaceId,
        resource.id,
        scope.runId,
        secret.protectedValueId,
      );
      expect(bound.added).toBe(1);
      await expect(
        service.useSecret(scope.workspaceId, resource.id, randomUUID(), secret.protectedValueId),
      ).rejects.toThrow("TEST_SECRET_SCOPE_INVALID");
      await expect(repo.events(randomUUID(), resource.id)).rejects.toThrow(
        "TEST_RESOURCE_NOT_FOUND",
      );
      await withProviderBudget(() => service.close(scope.workspaceId, resource.id));
      expect(await repo.events(scope.workspaceId, resource.id)).toHaveLength(1);
    }, 20000);
    it("hands off a saved invitation after disconnection while enforcing scope, expiry and active Run checks", async () => {
      const address = `invitation-${randomUUID()}@mail.example`;
      const account = { id: randomUUID(), password: "fictional-inbox-password" };
      const url = "https://fixture.example/accept?token=fictional_invitation_access";
      accounts.set(address, account);
      messages.set(address, [
        {
          id: randomUUID(),
          accountId: account.id,
          createdAt: new Date().toISOString(),
          subject: "Review your invitation",
          text: `Review invitation: ${url}`,
          html: [`<a href="${url}">Review invitation</a>`],
        },
      ]);
      const password = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: scope.projectId,
        displayName: "Invitation inbox",
        value: account.password,
        expiresInSeconds: null,
        idempotencyKey: randomUUID(),
      });
      const resource = await withProviderBudget(() =>
        service.connect(scope.workspaceId, scope.missionId, {
          name: "Restoration inbox",
          address,
          passwordCredentialId: password.protectedValueId,
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
      );
      await withProviderBudget(() =>
        service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
      );
      await service.close(scope.workspaceId, resource.id);
      const beforeRead = vi.mocked(fetch).mock.calls.length;
      const saved = await repo.events(scope.workspaceId, resource.id);
      const reference = saved[0]!.secrets.find((s) => s.kind === "link")!;
      expect(reference).toBeDefined();
      expect(JSON.stringify(saved)).not.toContain("fictional_invitation_access");
      const bind = () =>
        service.useSecret(scope.workspaceId, resource.id, scope.runId, reference.protectedValueId);
      expect((await bind()).browserSessionId).toBe(sessionId);
      expect((await bind()).replay).toBe(true);
      expect(
        await service.commands.protectedValueForBrowser(sessionId, reference.protectedValueId),
      ).toBe(url);
      expect(vi.mocked(fetch).mock.calls.length).toBe(beforeRead);
      expect(accounts.has(address)).toBe(true);
      await expect(
        service.useSecret(randomUUID(), resource.id, scope.runId, reference.protectedValueId),
      ).rejects.toThrow("TEST_RESOURCE_NOT_FOUND");
      await expect(
        service.useSecret(scope.workspaceId, resource.id, scope.runId, password.protectedValueId),
      ).rejects.toThrow("TEST_SECRET_SCOPE_INVALID");
      await db.query(
        "UPDATE protected_values SET expires_at=now()-interval '1 second' WHERE id=$1",
        [reference.protectedValueId],
      );
      await expect(bind()).rejects.toThrow("SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE");
      await expect(
        service.commands.protectedValueForBrowser(sessionId, reference.protectedValueId),
      ).rejects.toThrow("SCRY_BROWSER_PROTECTED_VALUE_UNAVAILABLE");
      await db.query("UPDATE protected_values SET expires_at=now()+interval '1 day' WHERE id=$1", [
        reference.protectedValueId,
      ]);
      await db.query("UPDATE runs SET state='finalizing' WHERE id=$1", [scope.runId]);
      try {
        await expect(bind()).rejects.toThrow("SCRY_BROWSER_RUN_NOT_ACTIVE");
      } finally {
        await db.query("UPDATE runs SET state='running' WHERE id=$1", [scope.runId]);
      }
    }, 20000);
    it("accepts only exact account references for received email", async () => {
      const resource = await allocate();
      const account = accounts.get(resource.address!)!;
      const message = {
        id: randomUUID(),
        accountId: account.id,
        createdAt: new Date().toISOString(),
        subject: "Account-reference qualification",
        text: "Fictional delivery",
      };
      messages.set(resource.address!, [message]);
      try {
        for (const accountId of [account.id, `/accounts/${account.id}`]) {
          message.accountId = accountId;
          expect(
            await providers.messages(
              "mailbox",
              { address: resource.address!, password: account.password },
              new Set(),
            ),
          ).toHaveLength(1);
        }
        for (const accountId of [
          "foreign-account",
          "/accounts/foreign-account",
          `https://api.mail.tm/accounts/${account.id}`,
          `/accounts/${account.id}/extra`,
          "",
        ]) {
          message.accountId = accountId;
          await expect(
            providers.messages(
              "mailbox",
              { address: resource.address!, password: account.password },
              new Set(),
            ),
          ).rejects.toThrow("TEST_PROVIDER_SCOPE_INVALID");
        }
      } finally {
        await withProviderBudget(() => service.close(scope.workspaceId, resource.id));
      }
    }, 20000);
    it("allocates an authenticated Hookdeck listener without exposing the project key", async () => {
      const key = randomUUID();
      const resource = await withProviderBudget(() =>
        service.create(scope.workspaceId, scope.missionId, {
          kind: "webhook",
          name: "Order notifications",
          idempotencyKey: key,
          expiresInSeconds: 3600,
        }),
      );
      expect(resource.address).toMatch(/^https:\/\/hkdk.events\//);
      expect(JSON.stringify(resource)).not.toContain("fictional-hookdeck-project-key");
      expect((await service.read(scope.workspaceId, resource.id, { waitSeconds: 0 })).status).toBe(
        "waiting",
      );
      await withProviderBudget(() => service.close(scope.workspaceId, resource.id));
      expect((await repo.resource(scope.workspaceId, resource.id)).state).toBe("closed");
    }, 20000);
    it("shares request pacing across separate client instances", async () => {
      await db.query("DELETE FROM test_provider_limits WHERE provider='hookdeck'");
      const at: number[] = [];
      const fetcher = async () => {
        at.push(Date.now());
        return response({});
      };
      const a = new ProviderHttp(db, "hookdeck", "https://fixture.example", fetcher),
        b = new ProviderHttp(db, "hookdeck", "https://fixture.example", fetcher);
      await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).request("/fixture")));
      at.sort((x, y) => x - y);
      expect(at[9]! - at[0]!).toBeGreaterThanOrEqual(1500);
    }, 10000);
    it("automatically waits through a transient 429 instead of returning it to the customer", async () => {
      let calls = 0;
      const at: number[] = [];
      const client = new ProviderHttp(db, "hookdeck", "https://fixture.example", async () => {
        at.push(Date.now());
        return ++calls === 1
          ? response({}, 429, { "retry-after": "1" })
          : response({ received: true });
      });
      expect((await client.request("/fixture")).data).toEqual({ received: true });
      expect(calls).toBe(2);
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
    }, 10000);
    it("returns normal waiting for a long cooldown without inflating the schedule", async () => {
      await db.query(
        "UPDATE test_provider_limits SET blocked_until=now()+interval '90 seconds',next_request_at=now() WHERE provider='mail_tm'",
      );
      const send = vi.fn();
      const client = new ProviderHttp(db, "mail_tm", "https://fixture.example", send);
      const before = (
        await db.query("SELECT next_request_at FROM test_provider_limits WHERE provider='mail_tm'")
      ).rows[0]!.next_request_at;
      try {
        const result = await withProviderBudget(() => client.request("/fixture"), 2000).catch(
          (e) => e,
        );
        expect(result).toBeInstanceOf(ProviderDeferred);
        expect(result.retryAfterSeconds).toBeGreaterThan(85);
        expect(send).not.toHaveBeenCalled();
        expect(
          (
            await db.query(
              "SELECT next_request_at FROM test_provider_limits WHERE provider='mail_tm'",
            )
          ).rows[0]!.next_request_at,
        ).toEqual(before);
      } finally {
        await db.query(
          "UPDATE test_provider_limits SET blocked_until=now(),next_request_at=now() WHERE provider='mail_tm'",
        );
      }
    });
    it("keeps pending setup and concurrent reads normal waiting rather than false closure", async () => {
      const pending = await repo.allocate(scope.workspaceId, scope.missionId, {
        kind: "mailbox",
        name: "Pending invite",
        idempotencyKey: randomUUID(),
        expiresInSeconds: 3600,
      });
      expect((await service.read(scope.workspaceId, pending.id, { waitSeconds: 0 })).status).toBe(
        "waiting",
      );
      const ready = await allocate();
      const row = await repo.resource(scope.workspaceId, ready.id);
      const lease = await repo.claim(row);
      try {
        expect(await service.read(scope.workspaceId, ready.id, { waitSeconds: 0 })).toMatchObject({
          status: "waiting",
          retryAfterSeconds: 2,
        });
      } finally {
        await repo.release(row.id, lease!);
      }
    }, 15000);
    it("fences stale writers and resumes the same identity after a lost creation response", async () => {
      const key = randomUUID();
      const row = await repo.allocate(scope.workspaceId, scope.missionId, {
        kind: "mailbox",
        name: "Invitation emails",
        idempotencyKey: key,
        expiresInSeconds: 3600,
      });
      const lease = await repo.claim(row);
      const state = {
        ...repo.open<any>(row.private_data, row.id),
        address: await providers.prepareMail(row.id),
      };
      await repo.savePrivate(row.id, lease!, state);
      await providers.provision("mailbox", row.id, state);
      await db.query(
        "UPDATE test_resources SET lease_until=now()-interval '1 second' WHERE id=$1",
        [row.id],
      );
      const recovered = await allocate(key);
      expect(recovered.id).toBe(row.id);
      expect(recovered.state).toBe("ready");
      await expect(repo.ready(row.id, lease!, state.address, state)).rejects.toThrow(
        "TEST_RESOURCE_BUSY",
      );
      expect([...accounts.keys()].filter((address) => address === state.address)).toHaveLength(1);
    }, 20000);
    it("blocks redirects, bounds body size and distinguishes a hard quota response", async () => {
      const redirect = vi.fn(async (_input: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        throw new TypeError("redirect");
      });
      const client = new ProviderHttp(db, "hookdeck", "https://fixture.example", redirect);
      await expect(client.request("//elsewhere.example")).rejects.toThrow(
        "TEST_PROVIDER_PATH_INVALID",
      );
      expect(redirect).not.toHaveBeenCalled();
      await expect(client.request("/fixture")).rejects.toBeInstanceOf(ProviderDeferred);
      const large = new ProviderHttp(db, "hookdeck", "https://fixture.example", async () =>
        response({ data: "x".repeat(524289) }),
      );
      await expect(large.request("/fixture")).rejects.toThrow("TEST_MESSAGE_TOO_LARGE");
      const quota = new ProviderHttp(db, "hookdeck", "https://fixture.example", async () =>
        response({}, 402),
      );
      await expect(quota.request("/fixture")).rejects.toThrow("TEST_PROVIDER_QUOTA_UNAVAILABLE");
    }, 10000);
    it("does not expose received access references as reusable Project credentials", async () => {
      const resource = await allocate();
      const account = accounts.get(resource.address!)!;
      messages.set(resource.address!, [
        {
          id: randomUUID(),
          accountId: account.id,
          createdAt: new Date().toISOString(),
          subject: "Login",
          text: "Your verification code is 654321",
        },
      ]);
      const received = await service.read(scope.workspaceId, resource.id, { waitSeconds: 0 });
      const references = received.events.flatMap((e) => e.secrets.map((s) => s.protectedValueId));
      const credentials = await service.commands.listProtectedInputs(
        scope.workspaceId,
        scope.projectId,
      );
      expect(credentials.some((c) => references.includes(c.id))).toBe(false);
    }, 15000);
    it("connects an existing mailbox, reads its old messages, and only disconnects it", async () => {
      const address = `existing-${randomUUID()}@mail.example`,
        password = "fictional-existing-mailbox-password";
      const account = { id: randomUUID(), password };
      accounts.set(address, account);
      messages.set(address, [
        {
          id: randomUUID(),
          accountId: account.id,
          createdAt: "2026-10-20T12:00:00Z",
          subject: "Existing message",
          text: "Older application invitation",
        },
      ]);
      const secret = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: scope.projectId,
        displayName: "Mail.tm existing mailbox",
        value: password,
        expiresInSeconds: null,
        idempotencyKey: randomUUID(),
      });
      const input = {
        name: "Existing invitation inbox",
        address,
        passwordCredentialId: secret.protectedValueId,
        idempotencyKey: randomUUID(),
        expiresInSeconds: 3600,
      };
      const before = creationCalls;
      const resource = await service.connect(scope.workspaceId, scope.missionId, input);
      expect(resource).toMatchObject({ ownership: "customer", state: "ready", address });
      expect((await service.connect(scope.workspaceId, scope.missionId, input)).id).toBe(
        resource.id,
      );
      expect(creationCalls).toBe(before);
      expect(JSON.stringify(resource)).not.toContain(password);
      const row = await repo.resource(scope.workspaceId, resource.id);
      expect(repo.open<any>(row.private_data, row.id).password).toBeUndefined();
      expect(
        (await service.read(scope.workspaceId, resource.id, { waitSeconds: 0 })).events[0]!.title,
      ).toBe("Existing message");
      await db.query("UPDATE protected_values SET state='revoked' WHERE id=$1", [
        secret.protectedValueId,
      ]);
      await expect(
        service.read(scope.workspaceId, resource.id, { waitSeconds: 0 }),
      ).rejects.toThrow("TEST_MAIL_CREDENTIAL_UNAVAILABLE");
      expect((await service.close(scope.workspaceId, resource.id)).state).toBe("closed");
      expect(accounts.get(address)?.id).toBe(account.id);
      expect(messages.get(address)).toHaveLength(1);
      await expect(
        service.create(scope.workspaceId, scope.missionId, {
          kind: "mailbox",
          name: input.name,
          idempotencyKey: input.idempotencyKey,
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow("TEST_RESOURCE_IDEMPOTENCY_CONFLICT");
    }, 20000);
    it("never creates a replacement after failed login or deletes a pending customer mailbox on expiry", async () => {
      const address = `owned-${randomUUID()}@mail.example`;
      accounts.set(address, { id: randomUUID(), password: "correct-fictional-password" });
      const secret = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: scope.projectId,
        displayName: "Wrong test password",
        value: "wrong-fictional-password",
        expiresInSeconds: null,
        idempotencyKey: randomUUID(),
      });
      const input = {
        name: "Do not replace",
        address,
        passwordCredentialId: secret.protectedValueId,
        idempotencyKey: randomUUID(),
        expiresInSeconds: 3600,
      };
      const before = creationCalls;
      await expect(service.connect(scope.workspaceId, scope.missionId, input)).rejects.toThrow(
        "TEST_PROVIDER_AUTH_REQUIRED",
      );
      const resource = (await repo.list(scope.workspaceId, scope.missionId)).find(
        (r) => r.idempotencyKey === input.idempotencyKey,
      )!;
      await db.query("UPDATE test_resources SET expires_at=now()-interval '1 second' WHERE id=$1", [
        resource.id,
      ]);
      expect((await service.connect(scope.workspaceId, scope.missionId, input)).state).toBe(
        "closed",
      );
      expect(creationCalls).toBe(before);
      expect(accounts.has(address)).toBe(true);
    }, 10000);
    it("refuses foreign credential references before contacting Mail.tm", async () => {
      const otherProject = randomUUID();
      await db.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Other mailbox project')",
        [otherProject, scope.workspaceId],
      );
      const foreign = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: otherProject,
        displayName: "Other Project mailbox password",
        value: "fictional-private-password",
        expiresInSeconds: null,
        idempotencyKey: randomUUID(),
      });
      const expired = await service.commands.createProtectedInput(scope.workspaceId, {
        projectId: scope.projectId,
        displayName: "Expired mailbox password",
        value: "fictional-expired-password",
        expiresInSeconds: 300,
        idempotencyKey: randomUUID(),
      });
      await db.query(
        "UPDATE protected_values SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired.protectedValueId],
      );
      const before = vi.mocked(fetch).mock.calls.length;
      await expect(
        service.connect(scope.workspaceId, scope.missionId, {
          name: "Foreign",
          address: "fictional@mail.example",
          passwordCredentialId: randomUUID(),
          idempotencyKey: randomUUID(),
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow("TEST_MAIL_CREDENTIAL_UNAVAILABLE");
      for (const id of [foreign.protectedValueId, expired.protectedValueId])
        await expect(
          service.connect(scope.workspaceId, scope.missionId, {
            name: "Unavailable",
            address: "fictional@mail.example",
            passwordCredentialId: id,
            idempotencyKey: randomUUID(),
            expiresInSeconds: 3600,
          }),
        ).rejects.toThrow("TEST_MAIL_CREDENTIAL_UNAVAILABLE");
      expect(vi.mocked(fetch).mock.calls.length).toBe(before);
    });
    it("enforces received-code Mission scope even through the general credential binder", async () => {
      const mission = randomUUID();
      await db.query(
        "INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key) VALUES($1,$2,'Other email test','Other invitation',$3)",
        [mission, scope.projectId, randomUUID()],
      );
      const resource = await service.create(scope.workspaceId, mission, {
        kind: "mailbox",
        name: "Other Mission inbox",
        idempotencyKey: randomUUID(),
        expiresInSeconds: 3600,
      });
      const account = accounts.get(resource.address!)!;
      messages.set(resource.address!, [
        {
          id: randomUUID(),
          accountId: account.id,
          createdAt: new Date().toISOString(),
          subject: "Login",
          text: "Your verification code is 123456",
        },
      ]);
      const receipt = await service.read(scope.workspaceId, resource.id, { waitSeconds: 0 });
      const value = receipt.events[0]!.secrets[0]!.protectedValueId;
      await expect(
        service.commands.bindProtectedInputs(scope.workspaceId, scope.runId, [value]),
      ).rejects.toThrow("SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE");
    }, 15000);
    it("does not provision an expired pending allocation on retry", async () => {
      const key = randomUUID();
      const row = await repo.allocate(scope.workspaceId, scope.missionId, {
        kind: "mailbox",
        name: "Invitation emails",
        idempotencyKey: key,
        expiresInSeconds: 3600,
      });
      await db.query("UPDATE test_resources SET expires_at=now()-interval '1 second' WHERE id=$1", [
        row.id,
      ]);
      const before = creationCalls;
      expect((await allocate(key)).state).toBe("closed");
      expect(creationCalls).toBe(before);
    });
    it("preserves unconfirmed closure when a committed provider deletion loses its receipt", async () => {
      const resource = await allocate();
      const row = await repo.resource(scope.workspaceId, resource.id);
      await providers.close("mailbox", repo.open(row.private_data, row.id));
      await expect(service.close(scope.workspaceId, resource.id)).rejects.toThrow(
        "TEST_PROVIDER_AUTH_REQUIRED",
      );
      expect((await repo.resource(scope.workspaceId, resource.id)).state).toBe("closing");
    }, 15000);
    it("serves authenticated HTTP routes with validation, workspace scope and read-only viewer access", async () => {
      const identity = (
        await db.query<{ id: string; email: string }>(
          "SELECT u.id,u.email FROM app_users u JOIN workspace_memberships w ON w.user_id=u.id WHERE w.workspace_id=$1 LIMIT 1",
          [scope.workspaceId],
        )
      ).rows[0]!;
      const principal: UserPrincipal = {
        kind: "user",
        subject: identity.id,
        userId: identity.id,
        email: identity.email,
        workspaceId: scope.workspaceId,
        role: "owner",
      };
      const tokens = new McpTokenRepository(db);
      const token = await tokens.create(principal, "HTTP integration fixture");
      @Module({
        controllers: [TestResourcesController],
        providers: [
          { provide: TestResourcesService, useValue: service },
          { provide: AuthService, useValue: new AuthService(new IdentityRepository(db)) },
          { provide: APP_GUARD, useClass: AuthGuard },
        ],
      })
      class HttpFixtureModule {}
      const app = await NestFactory.create<NestFastifyApplication>(
        HttpFixtureModule,
        new FastifyAdapter(),
        { logger: false },
      );
      try {
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        const headers = { authorization: `Bearer ${token.token}` };
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/missions/${scope.missionId}/test-resources`,
            })
          ).statusCode,
        ).toBe(401);
        const list = await app.inject({
          method: "GET",
          url: `/api/missions/${scope.missionId}/test-resources`,
          headers,
        });
        expect(list.statusCode).toBe(200);
        expect(list.headers["cache-control"]).toBe("private, no-store");
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/missions/${randomUUID()}/test-resources`,
              headers,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/missions/${scope.missionId}/test-resources`,
              headers,
              payload: {
                kind: "mailbox",
                name: "Invalid",
                idempotencyKey: "bad",
                expiresInSeconds: 0,
              },
            })
          ).statusCode,
        ).toBe(400);
        await db.query(
          "UPDATE workspace_memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
          [scope.workspaceId, identity.id],
        );
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/missions/${scope.missionId}/test-resources`,
              headers,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/missions/${scope.missionId}/test-resources`,
              headers,
              payload: {
                kind: "mailbox",
                name: "Viewer cannot create",
                idempotencyKey: randomUUID(),
              },
            })
          ).statusCode,
        ).toBe(403);
      } finally {
        await db.query(
          "UPDATE workspace_memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
          [scope.workspaceId, identity.id],
        );
        await tokens.revoke(principal, token.id as string);
        await app.close();
      }
    }, 15000);
  },
);
