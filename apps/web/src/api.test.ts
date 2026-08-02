import { afterEach, describe, expect, it, vi } from "vitest";

import { api, post } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard API client", () => {
  it("returns parsed API data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "project-1", name: "Scry" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(api("/projects")).resolves.toEqual([{ id: "project-1", name: "Scry" }]);
  });

  it("surfaces API errors and sends JSON posts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Plan validation failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(post("/plan-validations", { plan: {} })).rejects.toThrow(
      "Plan validation failed",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plan-validations",
      expect.objectContaining({ method: "POST", body: '{"plan":{}}' }),
    );
  });
});
