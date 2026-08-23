import { describe, expect, it, vi } from "vitest";

import { installApiRequestObservability } from "../src/infrastructure/index.js";

describe("API request operational observability", () => {
  it("emits sanitized route facts and an available correlation id for a refusal", async () => {
    let hook: Parameters<Parameters<typeof installApiRequestObservability>[0]["addHook"]>[1];
    const events = {
      emit: vi.fn(async () => {
        throw new Error("TELEMETRY_SINK_UNAVAILABLE");
      }),
    };
    installApiRequestObservability(
      {
        addHook: (_name, installed) => {
          hook = installed;
        },
      },
      events,
    );

    const payload = JSON.stringify({ message: "invalid input" });
    await expect(
      hook!(
        {
          method: "POST",
          headers: { "x-correlation-id": "correlation-1", authorization: "Bearer never-log" },
          routeOptions: { url: "/api/missions/:missionId" },
        },
        { statusCode: 400 },
        payload,
      ),
    ).resolves.toBe(payload);

    expect(events.emit).toHaveBeenCalledWith("api", {
      name: "api.request_rejected",
      classification: "validation",
      reasonCode: "API_REQUEST_REJECTED_400",
      outcome: "refused",
      causality: { correlationId: "correlation-1" },
      details: {
        method: "POST",
        route: "/api/missions/:missionId",
        status: 400,
      },
    });
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("never-log");
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("invalid input");
  });

  it("preserves a structured refusal code and classifies from that code before status", async () => {
    let hook: Parameters<Parameters<typeof installApiRequestObservability>[0]["addHook"]>[1];
    const events = { emit: vi.fn(async () => undefined) };
    installApiRequestObservability(
      {
        addHook: (_name, installed) => {
          hook = installed;
        },
      },
      events,
    );

    await hook!(
      { method: "POST", headers: {}, routeOptions: { url: "/api/missions/:missionId/report" } },
      { statusCode: 409 },
      JSON.stringify({ code: "MISSION_REVISION_CONFLICT", privateDiagnostic: "do-not-emit" }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({
        classification: "stale_authority",
        reasonCode: "MISSION_REVISION_CONFLICT",
      }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("do-not-emit");
  });

  it.each([
    {
      code: "MUTATION_RECONCILIATION_REQUIRED",
      status: 409,
      classification: "reconciliation_unknown",
    },
    {
      code: "MISSION_AUTHORIZATION_REQUIRED",
      status: 409,
      classification: "policy_refusal",
    },
    {
      code: "INPUT_VALIDATION_FAILED",
      status: 500,
      classification: "validation",
    },
  ])("classifies $code from the structured code before status", async (scenario) => {
    let hook: Parameters<Parameters<typeof installApiRequestObservability>[0]["addHook"]>[1];
    const events = { emit: vi.fn(async () => undefined) };
    installApiRequestObservability(
      {
        addHook: (_name, installed) => {
          hook = installed;
        },
      },
      events,
    );

    await hook!(
      { method: "POST", headers: {}, routeOptions: { url: "/api/test" } },
      { statusCode: scenario.status },
      JSON.stringify({ code: scenario.code }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({
        classification: scenario.classification,
        reasonCode: scenario.code,
      }),
    );
  });

  it("falls back to infrastructure classification for an unknown 5xx response", async () => {
    let hook: Parameters<Parameters<typeof installApiRequestObservability>[0]["addHook"]>[1];
    const events = { emit: vi.fn(async () => undefined) };
    installApiRequestObservability(
      {
        addHook: (_name, installed) => {
          hook = installed;
        },
      },
      events,
    );

    await hook!(
      { method: "GET", headers: {}, routeOptions: { url: "/api/test" } },
      { statusCode: 503 },
      JSON.stringify({ message: "private upstream diagnostic" }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({
        classification: "infrastructure",
        reasonCode: "API_REQUEST_REJECTED_503",
      }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("private upstream diagnostic");
  });
});
