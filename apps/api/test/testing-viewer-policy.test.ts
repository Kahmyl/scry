import "reflect-metadata";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { AuthService } from "../src/auth/auth.service.js";
import { BrowserProjectController } from "../src/browser-execution/controllers/browser-project.controller.js";
import { BrowserLifecycleController } from "../src/browser-execution/controllers/browser-lifecycle.controller.js";
import { BrowserProjectRepository } from "../src/browser-execution/repositories/browser-project.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserExecutionQueueService } from "../src/browser-execution/browser-execution-queue.service.js";
let app: NestFastifyApplication;
const create = vi.fn(async () => ({ id: "fictional" })),
  submit = vi.fn(async () => ({ commandId: "fictional", state: "queued" }));
beforeAll(async () => {
  process.env.SCRY_BROWSER_ENABLED = "true";
  @Module({
    controllers: [BrowserProjectController, BrowserLifecycleController],
    providers: [
      { provide: BrowserProjectRepository, useValue: { list: async () => [], create } },
      { provide: BrowserLifecycleRepository, useValue: {} },
      {
        provide: BrowserCommandRepository,
        useValue: { assertSessionAccess: async () => {}, submit },
      },
      { provide: BrowserExecutionRepository, useValue: {} },
      {
        provide: BrowserExecutionQueueService,
        useValue: { dispatchPendingCommands: async () => 0 },
      },
      {
        provide: AuthService,
        useValue: {
          authenticate: async (header: string) => ({
            kind: "user",
            credentialKind: "mcp",
            subject: "fixture",
            userId: "fixture",
            workspaceId: "fixture",
            role: header === "Bearer member" ? "member" : "viewer",
            email: "fictional@example.test",
          }),
        },
      },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
  class Fixture {}
  app = await NestFactory.create<NestFastifyApplication>(Fixture, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(() => app?.close());
it("a viewer can read recorded workspace inventory", async () => {
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: "Bearer viewer" },
      })
    ).statusCode,
  ).toBe(200);
});
it("a viewer cannot create a Project through an older mutation endpoint", async () => {
  const before = create.mock.calls.length;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { authorization: "Bearer viewer" },
        payload: { name: "Unauthorized fixture" },
      })
    ).statusCode,
  ).toBe(403);
  expect(create.mock.calls.length).toBe(before);
});
it("a viewer cannot queue even a recorded browser observation", async () => {
  const before = submit.mock.calls.length;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/browser-sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands",
        headers: { authorization: "Bearer viewer" },
        payload: { idempotencyKey: "viewer-observe", command: { kind: "observe" } },
      })
    ).statusCode,
  ).toBe(403);
  expect(submit.mock.calls.length).toBe(before);
});
it("role refusal precedes ordinary finalization validation", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/finalize",
        headers: { authorization: "Bearer viewer" },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
});
it("a member retains the supported Project creation path", async () => {
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { authorization: "Bearer member" },
        payload: { name: "Authorized fixture" },
      })
    ).statusCode,
  ).toBe(201);
});
