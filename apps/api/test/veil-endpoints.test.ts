import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EnvironmentsController } from "../src/controllers.js";
import { ScryRepository } from "../src/repository.js";
import { VeilPreferencesService } from "../src/veil-preferences.service.js";

const environmentId = "11111111-1111-4111-8111-111111111111";
const record = { schemaVersion: 1, environmentId, preferences: { profile: "private" }, effectivePolicy: { profile: "private", digest: "a".repeat(64) } };
const veil = { get: vi.fn(async () => record), tighten: vi.fn(async () => record) };
const repository = { updateEnvironment: vi.fn(), validateCredentialReferences: vi.fn() };

@Module({
  controllers: [EnvironmentsController],
  providers: [
    { provide: ScryRepository, useValue: repository },
    { provide: VeilPreferencesService, useValue: veil },
  ],
})
class TestModule {}

describe("Veil HTTP contract", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
    adapter.getInstance().addHook("preHandler", async (request) => { (request as unknown as { principal: unknown }).principal = { kind: "service", subject: "scry-service" }; });
    await app.init();
  });
  afterAll(async () => app.close());
  const call = (method: "GET" | "PATCH", payload?: unknown) => (app.getHttpAdapter().getInstance() as unknown as {
    inject(input: { method: string; url: string; payload?: unknown }): Promise<{ statusCode: number; json(): unknown }>;
  }).inject({ method, url: `/api/environments/${environmentId}/veil`, ...(payload ? { payload } : {}) });

  it("returns the authoritative effective profile", async () => {
    const response = await call("GET");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ effectivePolicy: { profile: "private" } });
  });

  it("validates and routes a tightening request", async () => {
    const response = await call("PATCH", { profile: "minimal_capture", reasonCode: "VEIL_USER_REQUESTED_PRIVACY" });
    expect(response.statusCode).toBe(200);
    expect(veil.tighten).toHaveBeenCalledWith(expect.anything(), environmentId, { profile: "minimal_capture", reasonCode: "VEIL_USER_REQUESTED_PRIVACY" });
  });

  it("rejects attempts to disable the hard floor before service execution", async () => {
    const calls = veil.tighten.mock.calls.length;
    const response = await call("PATCH", { controls: { quarantineUnknown: false }, reasonCode: "VEIL_USER_REQUESTED_PRIVACY" });
    expect(response.statusCode).toBe(400);
    expect(veil.tighten).toHaveBeenCalledTimes(calls);
  });
});
