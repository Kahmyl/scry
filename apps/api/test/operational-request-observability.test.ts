import { describe, expect, it, vi } from "vitest";

import { installApiRequestObservability } from "../src/infrastructure/index.js";

describe("API request operational observability", () => {
  it("emits sanitized route facts and an available correlation id for a refusal", async () => {
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
      {
        method: "POST",
        headers: { "x-correlation-id": "correlation-1", authorization: "Bearer never-log" },
        routeOptions: { url: "/api/missions/:missionId" },
      },
      { statusCode: 400 },
    );

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
  });
});
