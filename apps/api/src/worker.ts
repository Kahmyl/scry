import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";
import type { BrowserCommand } from "@scry/contracts";

import { AppModule } from "./app.module.js";
import { BrowserCommandRepository } from "./browser-execution/repositories/browser-command.repository.js";
import {
  BROWSER_COMMAND_QUEUE,
  BROWSER_EXECUTION_QUEUE,
  type BrowserExecutionJob,
} from "./browser-execution/browser-execution-queue.service.js";
import { BrowserExecutionRepository } from "./browser-execution/repositories/browser-execution.repository.js";
import { composePraxisExecutionPort } from "./browser-execution/browser-boundary-composition.js";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "./browser-execution/browser-runtime-capability.js";
import { RedisConnection } from "./infrastructure/redis.js";

if (process.env.SCRY_BROWSER_ENABLED !== "true") throw new Error("SCRY_BROWSER_DISABLED");
if (process.env.SCRY_BROWSER_RENDER_VIDEO !== "true")
  throw new Error("SCRY_BROWSER_VIDEO_RENDERING_REQUIRED");
const app = await NestFactory.createApplicationContext(AppModule);
const redis = app.get(RedisConnection);
const commands = app.get(BrowserCommandRepository);
const execution = app.get(BrowserExecutionRepository);
await execution.assertCompatibleBaseline();
const praxis = composePraxisExecutionPort(commands, execution);

const sessionWorker = new Worker<BrowserExecutionJob>(
  BROWSER_EXECUTION_QUEUE,
  async (job) => {
    if (job.data.runtimeCapabilityId !== BROWSER_RUNTIME_CAPABILITY_ID)
      throw new Error("SCRY_BROWSER_JOB_CAPABILITY_MISMATCH");
    return praxis.openSession(job.data.sessionId);
  },
  {
    connection: redis.client,
    concurrency: Number(process.env.SCRY_BROWSER_SESSION_CONCURRENCY ?? 4),
  },
);
const commandWorker = new Worker<{ commandId: string }>(
  BROWSER_COMMAND_QUEUE,
  async (job) => {
    const command = await commands.claim(job.data.commandId);
    if (!command) return { replay: true };
    const claimToken = command.claim_token;
    if (!claimToken) throw new Error("SCRY_BROWSER_COMMAND_CLAIM_TOKEN_MISSING");
    const heartbeat = setInterval(
      () => void commands.heartbeatClaim(command.id, claimToken).catch(() => undefined),
      20_000,
    );
    try {
      const result = await praxis.executeCommand(
        command.session_id,
        command.safe_input as BrowserCommand,
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
    concurrency: Number(process.env.SCRY_BROWSER_COMMAND_CONCURRENCY ?? 8),
  },
);

const shutdown = async () => {
  await Promise.allSettled([sessionWorker.close(), commandWorker.close()]);
  await praxis.shutdown();
  await app.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
