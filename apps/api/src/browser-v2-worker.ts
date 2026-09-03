import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";
import type { BrowserCommandV2 } from "@scry/contracts";

import { BrowserV2AppModule } from "./browser-v2-app.module.js";
import { BrowserCommandRepository } from "./browser-execution/repositories/browser-command.repository.js";
import {
  BROWSER_COMMAND_V2_QUEUE,
  BROWSER_EXECUTION_V2_QUEUE,
  type BrowserExecutionV2Job,
} from "./browser-execution/browser-execution-queue.service.js";
import { BrowserExecutionRepository } from "./browser-execution/repositories/browser-execution.repository.js";
import { BrowserV2WorkerEngine } from "./browser-execution/browser-v2-worker-engine.js";
import { BROWSER_RUNTIME_CAPABILITY_VERSION } from "./browser-execution/browser-runtime-capability.js";
import { RedisConnection } from "./infrastructure/redis.js";

if (process.env.BROWSER_V2_ENABLED !== "true") throw new Error("BROWSER_V2_DISABLED");
if (process.env.BROWSER_V2_RENDER_VIDEO !== "true")
  throw new Error("BROWSER_V2_VIDEO_RENDERING_REQUIRED");
const app = await NestFactory.createApplicationContext(BrowserV2AppModule);
const redis = app.get(RedisConnection);
const commands = app.get(BrowserCommandRepository);
const execution = app.get(BrowserExecutionRepository);
await execution.assertCompatibleBaseline();
const engine = new BrowserV2WorkerEngine(commands, execution);

const sessionWorker = new Worker<BrowserExecutionV2Job>(
  BROWSER_EXECUTION_V2_QUEUE,
  async (job) => {
    if (job.data.runtimeCapabilityVersion !== BROWSER_RUNTIME_CAPABILITY_VERSION)
      throw new Error("BROWSER_V2_JOB_CAPABILITY_MISMATCH");
    return engine.open(job.data.sessionId);
  },
  {
    connection: redis.client,
    concurrency: Number(process.env.BROWSER_V2_SESSION_CONCURRENCY ?? 4),
  },
);
const commandWorker = new Worker<{ commandId: string }>(
  BROWSER_COMMAND_V2_QUEUE,
  async (job) => {
    const command = await commands.claim(job.data.commandId);
    if (!command) return { replay: true };
    const claimToken = command.claim_token;
    if (!claimToken) throw new Error("BROWSER_V2_COMMAND_CLAIM_TOKEN_MISSING");
    const heartbeat = setInterval(
      () => void commands.heartbeatClaim(command.id, claimToken).catch(() => undefined),
      20_000,
    );
    try {
      const result = await engine.execute(
        command.session_id,
        command.safe_input as BrowserCommandV2,
      );
      await commands.complete(command.id, claimToken, result);
      return result;
    } catch (error) {
      await commands.fail(command.id, claimToken, error);
      return { failed: true };
    } finally {
      clearInterval(heartbeat);
    }
  },
  {
    connection: redis.client,
    concurrency: Number(process.env.BROWSER_V2_COMMAND_CONCURRENCY ?? 8),
  },
);

const shutdown = async () => {
  await Promise.allSettled([sessionWorker.close(), commandWorker.close()]);
  await engine.closeAll();
  await app.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
