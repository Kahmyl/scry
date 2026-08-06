import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PraxisController, PraxisService } from "../src/praxis/index.js";

const praxis = {
  createInspection: vi.fn(async () => ({
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "queued",
  })),
  getInspection: vi.fn(async () => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "completed",
    result: {
      resolution: "resolved",
    },
  })),
};

@Module({
  controllers: [PraxisController],
  providers: [
    {
      provide: PraxisService,
      useValue: praxis,
    },
  ],
})
class PraxisEndpointTestModule {}

const ids = {
  browserLeaseId: "11111111-1111-4111-8111-111111111111",
  probeSessionId: "22222222-2222-4222-8222-222222222222",
};

describe("Praxis HTTP contract", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const adapter = new FastifyAdapter();

    app = await NestFactory.create<NestFastifyApplication>(
      PraxisEndpointTestModule,
      adapter,
      { logger: false },
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(payload: unknown) {
    return (
      app.getHttpAdapter().getInstance() as unknown as {
        inject(options: {
          method: "POST";
          url: string;
          payload: unknown;
        }): Promise<{
          statusCode: number;
          json(): unknown;
        }>;
      }
    ).inject({
      method: "POST",
      url: "/api/praxis/candidate-inspections",
      payload,
    });
  }

  it("queues candidate inspection requests through the authoritative Praxis service", async () => {
    const response = await call({
      intent: {
        concept: "Continue",
        requiredCapabilities: ["pointer_activatable"],
        preferredEvidence: {
          roles: ["button"],
          names: ["Continue"],
          labels: [],
          descriptions: [],
          placeholders: [],
          inputTypes: [],
        },
        scope: { kind: "page" },
        relations: [],
        prohibited: ["hidden", "disabled"],
        risk: "ordinary",
        confidence: {
          requiredFamilies: [],
          minimum: 0.35,
          minimumMargin: 0.05,
          minimumFamilyCount: 1,
        },
      },
      allowedOrigins: ["https://example.com"],
      probeSessionId: ids.probeSessionId,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "queued",
    });

    expect(praxis.createInspection).toHaveBeenCalledOnce();
    expect(praxis.createInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        probeSessionId: ids.probeSessionId,
        allowedOrigins: ["https://example.com"],
      }),
    );
  });

  it("reads Praxis inspection state through the authoritative service", async () => {
    const response = await (
      app.getHttpAdapter().getInstance() as unknown as {
        inject(options: {
          method: "GET";
          url: string;
        }): Promise<{
          statusCode: number;
          json(): unknown;
        }>;
      }
    ).inject({
      method: "GET",
      url: "/api/praxis/candidate-inspections/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "completed",
      result: {
        resolution: "resolved",
      },
    });

    expect(praxis.getInspection).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("rejects malformed Praxis inspection ids before service execution", async () => {
    const before = praxis.getInspection.mock.calls.length;

    const response = await (
      app.getHttpAdapter().getInstance() as unknown as {
        inject(options: {
          method: "GET";
          url: string;
        }): Promise<{
          statusCode: number;
          json(): unknown;
        }>;
      }
    ).inject({
      method: "GET",
      url: "/api/praxis/candidate-inspections/not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(praxis.getInspection).toHaveBeenCalledTimes(before);
  });

  it("rejects malformed candidate inspection requests before service execution", async () => {
    const before = praxis.createInspection.mock.calls.length;

    const response = await call({
      intent: {},
      allowedOrigins: ["https://example.com"],
    });

    expect(response.statusCode).toBe(400);
    expect(praxis.createInspection).toHaveBeenCalledTimes(before);
  });
});
