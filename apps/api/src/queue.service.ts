import {
  ConflictException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";
import { Queue } from "bullmq";

import { ExecutionRepository } from "./execution.repository.js";
import { RedisConnection } from "./redis.js";

export const RUN_QUEUE_NAME = "scry-runs-v1";
export type RunJob = { runId: string };

@Injectable()
export class RunQueueService implements OnModuleDestroy {
  readonly queue: Queue<RunJob>;

  constructor(
    @Inject(RedisConnection) redis: RedisConnection,
    @Inject(ExecutionRepository) private readonly executions: ExecutionRepository,
  ) {
    this.queue = new Queue<RunJob>(RUN_QUEUE_NAME, {
      connection: redis.client,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }

  async start(runId: string) {
    const state = await this.executions.markQueued(runId);
    try {
      const existing = await this.queue.getJob(runId);
      if (!existing) {
        await this.queue.add("execute", { runId }, { jobId: runId });
      }
    } catch (error) {
      throw new ConflictException(
        `Run was marked queued but could not be submitted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return state;
  }

  async cancel(runId: string) {
    const state = await this.executions.requestCancellation(runId);
    const job = await this.queue.getJob(runId);
    if (job) {
      const jobState = await job.getState();
      if (jobState === "waiting" || jobState === "delayed") {
        await job.remove();
        await this.executions.cancelQueuedRun(runId);
      }
    }
    return state;
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
