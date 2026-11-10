import "reflect-metadata";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import {
  ProviderHttp,
  ProviderDeferred,
  withProviderBudget,
  providerTiming,
} from "../src/test-resources/provider-http.js";
import { TestResourceProviders } from "../src/test-resources/providers.js";
import { TestResourcesService } from "../src/test-resources/test-resources.service.js";
import { TestResourcesRepository } from "../src/test-resources/test-resources.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { randomBytes, randomUUID } from "node:crypto";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { seedSession } from "./fixtures/browser-session.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(url ? describe : describe.skip)("bounded provider scheduling and partial progress", () => {
  let db: Database;
  beforeAll(() => {
    process.env.DATABASE_URL = url;
    db = new Database();
  });
  afterAll(() => db?.onModuleDestroy());
  beforeEach(() => db.query("DELETE FROM test_provider_limits WHERE provider='mail_tm'"));
  it("bounds a blocked database schedule without any provider request", async () => {
    const locked = await db.pool.connect();
    await locked.query("BEGIN");
    await locked.query("LOCK TABLE test_provider_limits IN ACCESS EXCLUSIVE MODE");
    const fetcher = vi.fn(),
      before = performance.now();
    try {
      await expect(
        withProviderBudget(
          () =>
            new ProviderHttp(db, "mail_tm", "https://fictional.example", fetcher).request(
              "/domains",
            ),
          1500,
        ),
      ).rejects.toBeInstanceOf(ProviderDeferred);
      expect(performance.now() - before).toBeLessThan(2500);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await locked.query("ROLLBACK");
      locked.release();
    }
  });
  it("a metadata lock returns safe retryable unavailability within the declared read budget", async () => {
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    const service = new TestResourcesService(
      new TestResourcesRepository(db, new BrowserProtectedValueCipher()),
      new TestResourceProviders(db),
      {} as never,
    );
    const locked = await db.pool.connect();
    await locked.query("BEGIN");
    await locked.query("LOCK TABLE test_resources IN ACCESS EXCLUSIVE MODE");
    const before = performance.now();
    try {
      await expect(
        service.read(undefined, randomUUID(), { refresh: false, waitSeconds: 0 }),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: "TEST_RESOURCE_METADATA_UNAVAILABLE", retryAfterSeconds: 2 },
      });
      expect(performance.now() - before).toBeLessThan(3500);
    } finally {
      await locked.query("ROLLBACK");
      locked.release();
    }
  });
  it("a locked event baseline releases its claimed resource instead of stranding subsequent refreshes", async () => {
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    const cipher = new BrowserProtectedValueCipher(),
      repo = new TestResourcesRepository(db, cipher);
    const session = await seedSession(
      db,
      new BrowserExecutionRepository(db, cipher),
      "https://fixture.example",
    );
    const scope = (
      await db.query<any>(
        'SELECT mission_id AS "missionId" FROM browser_execution_sessions WHERE id=$1',
        [session],
      )
    ).rows[0];
    const row = await repo.allocate(undefined, scope.missionId, {
      kind: "mailbox",
      name: "Locked baseline fixture",
      idempotencyKey: randomUUID(),
      expiresInSeconds: 3600,
    });
    const lease = await repo.claim(row);
    await repo.ready(row.id, lease!, "fixture@example.test", {});
    await repo.release(row.id, lease!);
    const provider = new TestResourceProviders(db),
      providerRead = vi.spyOn(provider, "messages");
    const service = new TestResourcesService(repo, provider, {} as never);
    const locked = await db.pool.connect();
    await locked.query("BEGIN");
    await locked.query("LOCK TABLE test_resource_events IN ACCESS EXCLUSIVE MODE");
    try {
      await expect(
        service.read(undefined, row.id, { refresh: true, waitSeconds: 0 }),
      ).rejects.toMatchObject({ status: 503 });
      expect(providerRead).not.toHaveBeenCalled();
      expect(
        (await db.query("SELECT lease_id FROM test_resources WHERE id=$1", [row.id])).rows[0]!
          .lease_id,
      ).toBeNull();
    } finally {
      await locked.query("ROLLBACK");
      locked.release();
    }
  });
  it("nested budgets cannot extend an outer deadline; stalled transport becomes safe waiting", async () => {
    let calls = 0;
    const fetcher = (async (_url: unknown, options: RequestInit) => {
      calls++;
      return new Promise<Response>((_r, reject) =>
        options.signal?.addEventListener(
          "abort",
          () => reject(Error("private provider password must never escape")),
          { once: true },
        ),
      );
    }) as typeof fetch;
    const before = performance.now();
    let timing: any;
    await withProviderBudget(async () => {
      await expect(
        withProviderBudget(
          () =>
            new ProviderHttp(db, "mail_tm", "https://fictional.example", fetcher).request(
              "/messages",
            ),
          45000,
        ),
      ).rejects.toBeInstanceOf(ProviderDeferred);
      timing = providerTiming();
    }, 2200);
    expect(calls).toBe(1);
    expect(performance.now() - before).toBeLessThan(3000);
    expect(JSON.stringify(timing)).not.toContain("password");
  });
  it("reports a shared Retry-After cooldown without blocking beyond the read budget", async () => {
    const fetcher = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }),
    );
    let timing: any;
    await withProviderBudget(async () => {
      await expect(
        new ProviderHttp(db, "mail_tm", "https://fictional.example", fetcher).request("/messages"),
      ).rejects.toBeInstanceOf(ProviderDeferred);
      timing = providerTiming();
    }, 3000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(timing).toMatchObject({ providerRequests: 1, throttled: true });
    expect(timing.scheduleWaitMs).toBe(0);
  });
  it.each(["headers", "body"] as const)(
    "bounds a non-cooperative provider's stalled %s",
    async (mode) => {
      const cancelled = vi.fn();
      const fetcher = (async () =>
        mode === "headers"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ cancel: cancelled }))) as typeof fetch;
      const before = performance.now();
      await expect(
        withProviderBudget(
          () =>
            new ProviderHttp(db, "mail_tm", "https://fictional.example", fetcher).request(
              "/messages",
            ),
          2200,
        ),
      ).rejects.toBeInstanceOf(ProviderDeferred);
      expect(performance.now() - before).toBeLessThan(3000);
      if (mode === "body") expect(cancelled).toHaveBeenCalledOnce();
    },
  );
  it("retains a valid earlier message when a later provider call is deferred", async () => {
    const providers = new TestResourceProviders(db);
    (providers as any).mail = new ProviderHttp(
      db,
      "mail_tm",
      "https://fictional.example",
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/token") return Response.json({ token: "fictional-token", id: "account" });
        if (path === "/messages")
          return Response.json({ "hydra:member": [{ id: "first" }, { id: "second" }] });
        if (path === "/messages/first")
          return Response.json({
            id: "first",
            accountId: "account",
            createdAt: new Date().toISOString(),
            subject: "Receipt",
            text: "Fictional message",
          });
        throw Error("temporary unavailability");
      },
    );
    let timing: any;
    const results = await withProviderBudget(async () => {
      const result = await providers.messages(
        "mailbox",
        { address: "owned@fictional.example", password: "private-fictional" },
        new Set(),
      );
      timing = providerTiming();
      return result;
    }, 5000);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("first");
    expect(timing.partialRefresh).toBe(true);
  });
  it("separates actual schedule wait from request count", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    let timing: any;
    await withProviderBudget(async () => {
      const http = new ProviderHttp(db, "mail_tm", "https://fictional.example", fetcher);
      await http.request("/one");
      await http.request("/two");
      timing = providerTiming();
    }, 4000);
    expect(timing.providerRequests).toBe(2);
    expect(timing.scheduleWaitMs).toBeGreaterThan(100);
    expect(timing.pollingWaitMs).toBe(0);
    expect(timing.throttled).toBe(false);
  });
});
