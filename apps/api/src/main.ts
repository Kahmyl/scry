import "reflect-metadata";
import { selectedBrowserAdapter } from "./browser-execution/browser-adapter-selection.js";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { BrowserExecutionRepository } from "./browser-execution/repositories/browser-execution.repository.js";

if (process.env.SCRY_BROWSER_ENABLED !== "true") throw new Error("SCRY_BROWSER_DISABLED");
selectedBrowserAdapter();
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.get(BrowserExecutionRepository).assertCompatibleBaseline();
app.enableCors({
  origin: (process.env.API_CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim()),
});
app.enableShutdownHooks();
await app.listen(
  Number(process.env.API_PORT ?? process.env.SCRY_BROWSER_API_PORT ?? 4000),
  process.env.API_HOST ?? "127.0.0.1",
);
