import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("ScryApiClient", () => {
  it("calls the configured Scry API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "run-1", state: "queued" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient("http://scry.test/api");
    await expect(client.post("/runs/run-1/cancel")).resolves.toEqual({
      id: "run-1",
      state: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/api/runs/run-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns stable artifact URLs and useful errors", async () => {
    const client = new ScryApiClient("http://scry.test/api");
    expect(client.artifactUrl("artifact id")).toBe(
      "http://scry.test/api/artifacts/artifact%20id",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Run not found" }), { status: 404 }),
      ),
    );
    await expect(client.get("/runs/missing")).rejects.toThrow(
      "Scry API request failed: Run not found",
    );
  });

  it("updates API resources with PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "environment-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient("http://scry.test/api");
    await expect(client.patch("/environments/environment-1", { secretRefs: [] }))
      .resolves.toEqual({ id: "environment-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/api/environments/environment-1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("fails closed when the API does not advertise the cutoff Praxis versions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      releaseId: "development", schemaFingerprint: "development-baseline",
      praxis: { contractVersion: 1, runtimeVersion: "0", scoringPolicyVersion: 1, cutoff: true },
    }), { status: 200 })));
    await expect(new ScryApiClient("http://scry.test/api").requireCurrentRelease())
      .rejects.toThrow("SCRY_PRAXIS_VERSION_MISMATCH");
  });

  it("retrieves authenticated artifacts and uses the public artifact URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("evidence", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient(
      "http://api.internal/api",
      "token",
      "https://scry.example/api",
    );
    expect(client.artifactUrl("artifact id")).toBe(
      "https://scry.example/api/artifacts/artifact%20id",
    );
    await expect(client.getArtifact("artifact id")).resolves.toMatchObject({
      contentType: "text/plain",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.internal/api/artifacts/artifact%20id",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});
