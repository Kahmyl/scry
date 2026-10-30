import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";

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
import { processBrowserCommand } from "./browser-execution/browser-command-processor.js";
import {
  BrowserWorkRegistry,
  createBrowserWorkerShutdown,
} from "./browser-execution/worker-lifecycle.js";

if (process.env.SCRY_BROWSER_ENABLED !== "true") throw new Error("SCRY_BROWSER_DISABLED");
if (process.env.SCRY_BROWSER_RENDER_VIDEO !== "true")
  throw new Error("SCRY_BROWSER_VIDEO_RENDERING_REQUIRED");
const app = await NestFactory.createApplicationContext(AppModule);
const redis = app.get(RedisConnection);
const commands = app.get(BrowserCommandRepository);
const execution = app.get(BrowserExecutionRepository);
await execution.assertCompatibleBaseline();
const work = new BrowserWorkRegistry();
const praxis = composePraxisExecutionPort(commands, execution, {
  onUnconfirmedRuntime: () => {
    work.failRuntime();
    stop();
  },
});

const sessionWorker = new Worker<BrowserExecutionJob>(
  BROWSER_EXECUTION_QUEUE,
  (job, token) =>
    work.run(job, token, async () => {
      if (job.data.runtimeCapabilityId !== BROWSER_RUNTIME_CAPABILITY_ID)
        throw new Error("SCRY_BROWSER_JOB_CAPABILITY_MISMATCH");
      return praxis.openSession(job.data.sessionId);
    }),
  {
    connection: redis.client,
    concurrency: Number(process.env.SCRY_BROWSER_SESSION_CONCURRENCY ?? 4),
  },
);
const commandWorker = new Worker<{ commandId: string }>(
  BROWSER_COMMAND_QUEUE,
  (job, token) =>
    work.run(job, token, () =>
      processBrowserCommand(commands, praxis, job, token, {
        onUnconfirmedDrain: () => {
          work.failRuntime();
          stop();
        },
      }),
    ),
  {
    connection: redis.client,
    concurrency: Number(process.env.SCRY_BROWSER_COMMAND_CONCURRENCY ?? 8),
  },
);

const shutdown = createBrowserWorkerShutdown({
  registry: work,
  workers: [sessionWorker, commandWorker],
  praxis,
  closeApplication: () => app.close(),
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const transportFailed = () => {
  work.failTransport();
  stop();
};
sessionWorker.on("error", transportFailed);
commandWorker.on("error", transportFailed);
