import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MissionController, MissionService } from "../src/missions/index.js";
import { OrchestrationService } from "../src/orchestration/index.js";

const service = {
  create: vi.fn(async () => ({ missionId: ids.mission, agentSessionId: ids.session })),
  list: vi.fn(async () => []),
  get: vi.fn(async () => ({ id: ids.mission })),
  update: vi.fn(async () => ({ id: ids.mission, title: "Corrected" })),
  activities: vi.fn(async () => []),
  relateActivities: vi.fn(),
  startSession: vi.fn(async () => ({ agentSessionId: ids.session })),
  endSession: vi.fn(),
  createObjective: vi.fn(async () => ({ id: ids.objective })),
  updateObjective: vi.fn(),
  attachFlow: vi.fn(),
  classifyRun: vi.fn(),
  acceptEvidence: vi.fn(),
  updateResumePointer: vi.fn(),
  transition: vi.fn(),
  previewReport: vi.fn(),
  publishReport: vi.fn(),
  listReports: vi.fn(async () => []),
  getReport: vi.fn(),
};
const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  mission: "22222222-2222-4222-8222-222222222222",
  session: "33333333-3333-4333-8333-333333333333",
  objective: "44444444-4444-4444-8444-444444444444",
};
const orchestration = {
  createPlan: vi.fn(),
  validate: vi.fn(),
  activate: vi.fn(),
  status: vi.fn(),
  startReady: vi.fn(),
  control: vi.fn(),
  grantAuthorization: vi.fn(),
};
@Module({
  controllers: [MissionController],
  providers: [
    { provide: MissionService, useValue: service },
    { provide: OrchestrationService, useValue: orchestration },
  ],
})
class TestModule {}

describe("Mission HTTP contract", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    const adapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
    adapter.getInstance().addHook("preHandler", async (request) => {
      (request as unknown as { principal: unknown }).principal = {
        kind: "service",
        subject: "scry-service",
      };
    });
    await app.init();
  });
  afterAll(async () => app.close());
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    (
      app.getHttpAdapter().getInstance() as unknown as {
        inject(o: {
          method: string;
          url: string;
          payload?: unknown;
        }): Promise<{ statusCode: number; json(): unknown }>;
      }
    ).inject({ method, url, ...(payload ? { payload } : {}) });
  it("creates a Mission and first agent session through the authoritative service", async () => {
    const response = await call("POST", `/api/projects/${ids.project}/missions`, {
      title: "Partner workflow",
      originalInstruction: "Test the workflow",
      instructionSnapshot: "Test the workflow",
      provider: "codex",
      idempotencyKey: "mission-command-1",
    });
    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledOnce();
  });
  it("rejects malformed objective context before service execution", async () => {
    const before = service.createObjective.mock.calls.length;
    const response = await call("POST", `/api/missions/${ids.mission}/objectives`, {
      missionId: ids.mission,
      agentSessionId: "invalid",
      title: "Login",
      dependencies: [],
      completionCriteria: [{ description: "Login passes", required: true }],
      order: 0,
    });
    expect(response.statusCode).toBe(400);
    expect(service.createObjective).toHaveBeenCalledTimes(before);
  });
  it("routes a valid ordered objective", async () => {
    const response = await call("POST", `/api/missions/${ids.mission}/objectives`, {
      missionId: ids.mission,
      agentSessionId: ids.session,
      title: "Login",
      description: "Authenticate",
      dependencies: [],
      completionCriteria: [{ description: "Login passes", required: true }],
      order: 0,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: ids.objective });
  });
  it("routes Mission corrections through the authoritative service", async () => {
    const response = await call("PATCH", `/api/missions/${ids.mission}`, {
      missionId: ids.mission,
      agentSessionId: ids.session,
      title: "Corrected",
    });
    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(
      expect.anything(),
      ids.mission,
      expect.objectContaining({ title: "Corrected" }),
    );
  });
});
