import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CalibrationController } from "../src/calibration.controller.js";
import { CalibrationService } from "../src/calibration.service.js";
import { FlowController } from "../src/flow.controller.js";
import { FlowService } from "../src/flow.service.js";
import { RunQueueService } from "../src/queue.service.js";

const calibration = {
  request: vi.fn(async () => ({ route: "request" })),
  list: vi.fn(async () => ({ route: "list" })),
  get: vi.fn(async () => ({ route: "get" })),
  decide: vi.fn(async (_principal, _calibrationId, _attestationId, decision) => ({ route: decision })),
  retry: vi.fn(async () => ({ route: "retry" })),
  cancel: vi.fn(async () => ({ route: "cancel" })),
};
const flow = {
  bindCalibration: vi.fn(async () => ({ route: "bind" })),
  capabilities: vi.fn(), readiness: vi.fn(), validate: vi.fn(), createFlow: vi.fn(),
  listFlows: vi.fn(), reviseFlow: vi.fn(), createRun: vi.fn(),
};
const queue = { dispatchPending: vi.fn() };

@Module({
  controllers: [CalibrationController, FlowController],
  providers: [
    { provide: CalibrationService, useValue: calibration },
    { provide: FlowService, useValue: flow },
    { provide: RunQueueService, useValue: queue },
  ],
})
class CalibrationEndpointTestModule {}

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  revision: "22222222-2222-4222-8222-222222222222",
  environment: "33333333-3333-4333-8333-333333333333",
  calibration: "44444444-4444-4444-8444-444444444444",
  attestation: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
  flow: "77777777-7777-4777-8777-777777777777",
  mission:"88888888-8888-4888-8888-888888888888",
  objective:"99999999-9999-4999-8999-999999999999",
  agentSession:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const missionContext={missionId:ids.mission,objectiveId:ids.objective,agentSessionId:ids.agentSession};

describe("calibration HTTP contract", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(CalibrationEndpointTestModule, adapter, { logger: false });
    adapter.getInstance().addHook("preHandler", async (request) => {
      (request as unknown as { principal: unknown }).principal = {
        kind: "user", subject: "test", userId: ids.project, email: "owner@example.test",
        workspaceId: ids.project, role: "owner",
      };
    });
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  async function call(method: "GET" | "POST", url: string, payload?: unknown) {
    const fastify = app.getHttpAdapter().getInstance() as unknown as {
      inject(options: { method: "GET" | "POST"; url: string; payload?: unknown }): Promise<{
        statusCode: number;
        json(): unknown;
      }>;
    };
    return fastify.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  it("routes every calibration lifecycle endpoint through its authoritative service", async () => {
    const request = await call("POST", `/api/projects/${ids.project}/calibration-sessions`, {
      ...missionContext,
      name: "Synthetic credential calibration", sourceFlowRevisionId: ids.revision,
      operationId: "capture-secret", environmentId: ids.environment,
      disposableDataConfirmed: true, confirmedUserAuthorized: true,
      purpose: "Verify the complete calibration lifecycle", idempotencyKey: "request-unique-1",
    });
    expect(request.statusCode).toBe(201);
    expect(calibration.request).toHaveBeenCalledOnce();

    expect((await call("GET", `/api/projects/${ids.project}/calibrations`)).json()).toEqual({ route: "list" });
    expect((await call("GET", `/api/calibrations/${ids.calibration}`)).json()).toEqual({ route: "get" });
    expect((await call("POST", `/api/calibrations/${ids.calibration}/attestations/${ids.attestation}/approve`, {...missionContext,confirmedUserAuthorized:true,reasonCode:"VERIFIED"})).json()).toEqual({route:"approved"});
    expect((await call("POST", `/api/calibrations/${ids.calibration}/attestations/${ids.attestation}/reject`, {...missionContext,reasonCode:"STRUCTURAL_DRIFT"})).json()).toEqual({route:"rejected"});
    expect((await call("POST", `/api/calibration-sessions/${ids.session}/retry`, {...missionContext,idempotencyKey:"retry-unique-1"})).json()).toEqual({route:"retry"});
    expect((await call("POST", `/api/calibration-sessions/${ids.session}/cancel`,missionContext)).json()).toEqual({route:"cancel"});
    expect((await call("POST", `/api/flows/${ids.flow}/calibration-bindings`, {
      ...missionContext,reason:"Bind verified calibration",
      expectedRevisionId: ids.revision, environmentId: ids.environment, operationId: "capture-secret",
      attestationId: ids.attestation, idempotencyKey: "binding-unique-1",
    })).json()).toEqual({ route: "bind" });
  });

  it("rejects malformed caller-authored calibration input before service execution", async () => {
    const callsBefore = calibration.request.mock.calls.length;
    const response = await call("POST", `/api/projects/${ids.project}/calibration-sessions`, {
      ...missionContext,
      name: "Unsafe request", sourceFlowRevisionId: ids.revision, operationId: "capture-secret",
      environmentId: ids.environment, disposableDataConfirmed: true, confirmedUserAuthorized: true,
      purpose: "Attempt to inject attestation output", idempotencyKey: "unsafe-unique-1",
      boundaryFingerprint: "caller-authored",
    });
    expect(response.statusCode).toBe(400);
    expect(calibration.request).toHaveBeenCalledTimes(callsBefore);
  });
});
