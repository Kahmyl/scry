import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";

import { RedisConnection } from "../infrastructure/redis.js";
import { BrowserExecutionRepository } from "./repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "./repositories/browser-command.repository.js";

const queueNamespace = process.env.SCRY_BROWSER_QUEUE_NAMESPACE?.trim();
if (queueNamespace && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(queueNamespace))
  throw new Error("SCRY_BROWSER_QUEUE_NAMESPACE_INVALID");
const scopedQueueName = (base: string) => (queueNamespace ? `${base}-${queueNamespace}` : base);

export const BROWSER_EXECUTION_QUEUE = scopedQueueName("scry-browser-execution");
export const BROWSER_COMMAND_QUEUE = scopedQueueName("scry-browser-command");
export interface BrowserExecutionJob {
  sessionId: string;
  runtimeCapabilityId: string;
}

@Injectable()
export class BrowserExecutionQueueService implements OnModuleInit, OnModuleDestroy {
  readonly queue: Queue<BrowserExecutionJob>;
  readonly commandQueue: Queue<{ commandId: string }>;
  #dispatcher?: NodeJS.Timeout;

  constructor(
    @Inject(RedisConnection) redis: RedisConnection,
    @Inject(BrowserExecutionRepository) private readonly repository: BrowserExecutionRepository,
    @Inject(BrowserCommandRepository) private readonly commands: BrowserCommandRepository,
  ) {
    this.queue = new Queue(BROWSER_EXECUTION_QUEUE, {
      connection: redis.client,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 500 },
    });
    this.commandQueue = new Queue(BROWSER_COMMAND_QUEUE, {
      connection: redis.client,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "fixed", delay: 20_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.SCRY_BROWSER_ENABLED !== "true") return;
    await this.dispatchPending();
    await this.dispatchPendingCommands();
    this.#dispatcher = setInterval(
      () => void Promise.allSettled([this.dispatchPending(), this.dispatchPendingCommands()]),
      1_000,
    );
  }

  async dispatchPendingCommands(limit = 100): Promise<number> {
    if (process.env.SCRY_BROWSER_ENABLED !== "true") throw new Error("SCRY_BROWSER_DISABLED");
    const pending = await this.commands.pending(limit);
    let dispatched = 0;
    for (const command of pending) {
      const existing = await this.commandQueue.getJob(command.commandId);
      if (!existing) await this.commandQueue.add("execute", command, { jobId: command.commandId });
      await this.commands.markPublished(command.commandId);
      dispatched += 1;
    }
    return dispatched;
  }

  async dispatchPending(limit = 100): Promise<number> {
    if (process.env.SCRY_BROWSER_ENABLED !== "true") throw new Error("SCRY_BROWSER_DISABLED");
    const sessions = await this.repository.pendingSessions(limit);
    let dispatched = 0;
    for (const session of sessions) {
      try {
        const existing = await this.queue.getJob(session.sessionId);
        if (!existing) await this.queue.add("start", session, { jobId: session.sessionId });
        await this.repository.markSessionPublished(session.sessionId);
        dispatched += 1;
      } catch (error) {
        await this.repository.markSessionPublishFailed(session.sessionId, safeCode(error));
      }
    }
    return dispatched;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#dispatcher) clearInterval(this.#dispatcher);
    await this.queue.close();
    await this.commandQueue.close();
  }
}

function safeCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[^A-Za-z0-9:_-]/gu, "_").slice(0, 500);
}
