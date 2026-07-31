import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter(),
);
app.setGlobalPrefix("v1");
app.enableCors({
  origin: (process.env.API_CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim()),
});
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? "127.0.0.1");
