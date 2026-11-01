import { randomBytes, randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { PraxisExecutionPort } from "@scry/contracts";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";
import { seedSession } from "./fixtures/browser-session.js";

const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL,
  redisUrl = process.env.REDIS_URL;
const run = url && redisUrl ? describe : describe.skip;
run("real queue ordered-command deferral", () => {
  it("survives out-of-order delivery with attempts=1 and executes each action once", async () => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    const database = new Database(),
      cipher = new BrowserProtectedValueCipher(),
      commands = new BrowserCommandRepository(database, cipher),
      effects = new BrowserExecutionRepository(database, cipher);
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null }),
      name = "order-" + randomUUID(),
      queue = new Queue<{ commandId: string }>(name, { connection }),
      events = new QueueEvents(name, { connection });
    let dispatches = 0;
    const praxis = {
      executeCommand: vi.fn(async () => ({ dispatch: ++dispatches })),
    } as unknown as PraxisExecutionPort;
    const worker = new Worker<{ commandId: string }>(
      name,
      (job, token) => processBrowserCommand(commands, praxis, job, token),
      { connection, concurrency: 4 },
    );
    try {
      await events.waitUntilReady();
      const session = await seedSession(database, effects, "https://fixture.example");
      const first = await commands.submit(session, {
          idempotencyKey: randomUUID(),
          command: { kind: "observe" },
        }),
        second = await commands.submit(session, {
          idempotencyKey: randomUUID(),
          command: { kind: "observe" },
        });
      // Deliver the successor first. Waiting for an earlier durable ordinal is
      // not a job failure and must not exhaust its single allowed attempt.
      const later = await queue.add("command", { commandId: second.commandId }, { attempts: 1 });
      await vi.waitFor(async () => expect(await later.getState()).toBe("delayed"), {
        timeout: 5000,
      });
      const persistedLater = await queue.getJob(later.id!);
      expect(persistedLater?.attemptsMade).toBe(0);
      expect(dispatches).toBe(0);
      const earlier = await queue.add("command", { commandId: first.commandId }, { attempts: 1 });
      expect(await earlier.waitUntilFinished(events, 10000)).toEqual({ dispatch: 1 });
      expect(await later.waitUntilFinished(events, 10000)).toEqual({ dispatch: 2 });
      expect(dispatches).toBe(2);
      expect((await commands.observe(first.commandId)).result).toEqual({ dispatch: 1 });
      expect((await commands.observe(second.commandId)).result).toEqual({ dispatch: 2 });
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
      await connection.quit();
      await database.onModuleDestroy();
    }
  }, 20000);
});
