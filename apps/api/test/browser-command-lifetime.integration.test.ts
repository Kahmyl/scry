import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupervisedBrowser } from "@scry/praxis";
import { composePraxisExecutionPort } from "../src/browser-execution/browser-boundary-composition.js";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";
import {
  BrowserWorkRegistry,
  createBrowserWorkerShutdown,
} from "../src/browser-execution/worker-lifecycle.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";
const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL,
  redisUrl = process.env.REDIS_URL;
const live =
  databaseUrl && redisUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
live("actual queue carried command lifetime", () => {
  let database: Database, effects: BrowserExecutionRepository, origin: string;
  let requested: (() => void) | undefined;
  const server = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<title>Busy native command fixture</title><script>while(true){}</script>");
    requested?.();
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_RENDER_VIDEO = "false";
    process.env.SCRY_BROWSER_ARTIFACT_ROOT = await mkdtemp(
      path.join(os.tmpdir(), "praxis-queue-lifetime-"),
    );
    database = new Database();
    effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function requestSeen(seen: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        seen,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("fixture_native_request_timeout")), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function runtime() {
    const commands = new BrowserCommandRepository(database, new BrowserProtectedValueCipher());
    const praxis = composePraxisExecutionPort(commands, effects),
      registry = new BrowserWorkRegistry();
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null }),
      name = "command-lifetime-" + randomUUID();
    const queue = new Queue<{ commandId: string }>(name, { connection }),
      events = new QueueEvents(name, { connection });
    const launch = vi.spyOn(SupervisedBrowser, "launch");
    let shutdown!: () => Promise<void>;
    const worker = new Worker<{ commandId: string }>(
      name,
      (job, token) =>
        registry.run(job, token, () =>
          processBrowserCommand(commands, praxis, job, token, {
            onUnconfirmedDrain: () => {
              registry.failRuntime();
              void shutdown().catch(() => undefined);
            },
          }),
        ),
      { connection, concurrency: 1 },
    );
    worker.on("error", () => {
      registry.failTransport();
      void shutdown().catch(() => undefined);
    });
    shutdown = createBrowserWorkerShutdown({
      registry,
      workers: [worker],
      praxis,
      closeApplication: async () => undefined,
    });
    await events.waitUntilReady();
    return {
      commands,
      queue,
      events,
      launch,
      async close() {
        try {
          await shutdown();
        } finally {
          launch.mockRestore();
          await events.close();
          await queue.close();
          await connection.quit();
        }
      },
    };
  }
  it("fails an expired durable command through Redis without launching any browser", async () => {
    const f = await runtime();
    try {
      const session = await seedSession(database, effects, origin);
      const { commandId } = await f.commands.submit(session, {
        idempotencyKey: randomUUID(),
        command: { kind: "observe" },
      });
      await database.query(
        "UPDATE browser_commands SET execution_deadline_at=clock_timestamp()-interval '1 second',execution_budget_ms=120000 WHERE id=$1",
        [commandId],
      );
      const job = await f.queue.add("command", { commandId }, { attempts: 1 });
      expect(await job.waitUntilFinished(f.events, 10000)).toEqual({ failed: true });
      expect(f.launch).not.toHaveBeenCalled();
      expect(await f.commands.observe(commandId)).toMatchObject({
        state: "failed",
        errorCode: "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED",
      });
    } finally {
      await f.close();
    }
  }, 30000);
  it("physically stops a busy native browser when its carried execution deadline expires", async () => {
    const f = await runtime();
    try {
      const session = await seedSession(database, effects, origin);
      const { commandId } = await f.commands.submit(session, {
        idempotencyKey: randomUUID(),
        command: { kind: "navigate", url: origin },
      });
      await database.query(
        "UPDATE browser_commands SET execution_deadline_at=clock_timestamp()+interval '2 seconds',execution_budget_ms=120000 WHERE id=$1",
        [commandId],
      );
      const seen = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const job = await f.queue.add("command", { commandId }, { attempts: 1 });
      await requestSeen(seen);
      const browser = await f.launch.mock.results.at(-1)!.value;
      expect(await job.waitUntilFinished(f.events, 15000)).toEqual({ failed: true });
      expect(browser.exitConfirmed).toBe(true);
      expect(browser.browser.isConnected()).toBe(false);
      const result = await f.commands.observe(commandId);
      expect(result.state).toBe("failed");
      // Custodian budgets conservatively include transport time. It may fence
      // dispatch just before the controller's timer; positive stop is still
      // required, and unconfirmed termination is never an accepted outcome.
      expect([
        "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED",
        "SCRY_BROWSER_ACTION_TIMEOUT",
        "SCRY_BROWSER_OWNER_FENCED",
      ]).toContain(result.errorCode);
    } finally {
      requested = undefined;
      await f.close();
    }
  }, 30000);
  it("cancels on a real database-fenced heartbeat without letting the stale claimant write failure", async () => {
    const f = await runtime();
    const originalClaim = f.commands.claim.bind(f.commands);
    // Use the supported minimum claim lease so the actual renewal is exercised
    // promptly; no fake clock or copied heartbeat implementation participates.
    const claim = vi
      .spyOn(f.commands, "claim")
      .mockImplementation((id) => originalClaim(id, 30000));
    try {
      const session = await seedSession(database, effects, origin);
      const { commandId } = await f.commands.submit(session, {
        idempotencyKey: randomUUID(),
        command: { kind: "navigate", url: origin },
      });
      const seen = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const job = await f.queue.add("command", { commandId }, { attempts: 1 });
      await requestSeen(seen);
      const browser = await f.launch.mock.results.at(-1)!.value;
      await database.query(
        "UPDATE browser_commands SET claim_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [commandId],
      );
      await expect(job.waitUntilFinished(f.events, 40000)).rejects.toThrow("COMMAND_CLAIM_FENCED");
      expect(browser.exitConfirmed).toBe(true);
      expect(browser.browser.isConnected()).toBe(false);
      expect((await f.commands.observe(commandId)).state).toBe("running");
      const row = await database.query(
        "SELECT claim_token,completed_at FROM browser_commands WHERE id=$1",
        [commandId],
      );
      expect(row.rows[0]!.claim_token).toBeTruthy();
      expect(row.rows[0]!.completed_at).toBeNull();
    } finally {
      claim.mockRestore();
      requested = undefined;
      await f.close();
    }
  }, 60000);
});
