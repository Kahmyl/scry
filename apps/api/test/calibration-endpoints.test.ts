import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CalibrationController, CalibrationService } from "../src/calibration/index.js";
import { FlowController, FlowService } from "../src/flows/index.js";

const calibration = {
  list: vi.fn(async () => ({ route: "list" })),
  get: vi.fn(async () => ({ route: "get" })),
  request: vi.fn(),
  decide: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
};
const flow = {
  capabilities: vi.fn(),
  readiness: vi.fn(),
  validate: vi.fn(),
  createFlow: vi.fn(),
  listFlows: vi.fn(),
  getFlow: vi.fn(),
  reviseFlow: vi.fn(),
  createRun: vi.fn(),
  bindCalibration: vi.fn(),
};

@Module({
  controllers: [CalibrationController, FlowController],
  providers: [
    { provide: CalibrationService, useValue: calibration },
    { provide: FlowService, useValue: flow },
  ],
})
class CalibrationEndpointTestModule {}

describe("calibration HTTP compatibility", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(CalibrationEndpointTestModule, adapter, {
      logger: false,
    });
    adapter.getInstance().addHook("preHandler", async (request) => {
      (request as unknown as { principal: unknown }).principal = {
        kind: "user",
        subject: "test",
        userId: "11111111-1111-4111-8111-111111111111",
        email: "owner@example.test",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        role: "owner",
      };
    });
    await app.init();
  });
  afterAll(async () => app.close());

  async function call(method: "GET" | "POST", url: string, payload?: unknown) {
    const fastify = app.getHttpAdapter().getInstance() as unknown as {
      inject(options: { method: "GET" | "POST"; url: string; payload?: unknown }): Promise<{
        statusCode: number;
        json(): unknown;
      }>;
    };
    return fastify.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  it("keeps historical calibration evidence readable", async () => {
    expect(
      (await call("GET", "/api/projects/11111111-1111-4111-8111-111111111111/calibrations")).json(),
    ).toEqual({ route: "list" });
    expect(
      (await call("GET", "/api/calibrations/44444444-4444-4444-8444-444444444444")).json(),
    ).toEqual({ route: "get" });
  });

  it("retires calibration mutation and Flow-binding authority from the public API", async () => {
    const retired = [
      "/api/projects/11111111-1111-4111-8111-111111111111/calibration-sessions",
      "/api/calibrations/44444444-4444-4444-8444-444444444444/attestations/55555555-5555-4555-8555-555555555555/approve",
      "/api/calibration-sessions/66666666-6666-4666-8666-666666666666/retry",
      "/api/flows/77777777-7777-4777-8777-777777777777/calibration-bindings",
    ];
    for (const url of retired) expect((await call("POST", url, {})).statusCode).toBe(404);
    expect(calibration.request).not.toHaveBeenCalled();
    expect(calibration.decide).not.toHaveBeenCalled();
    expect(calibration.retry).not.toHaveBeenCalled();
    expect(flow.bindCalibration).not.toHaveBeenCalled();
  });
});
