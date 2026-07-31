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
    const client = new ScryApiClient("http://scry.test/v1");
    await expect(client.post("/runs/run-1/start")).resolves.toEqual({
      id: "run-1",
      state: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/v1/runs/run-1/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns stable artifact URLs and useful errors", async () => {
    const client = new ScryApiClient("http://scry.test/v1");
    expect(client.artifactUrl("artifact id")).toBe(
      "http://scry.test/v1/artifacts/artifact%20id",
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
    const client = new ScryApiClient("http://scry.test/v1");
    await expect(client.patch("/environments/environment-1", { secretRefs: [] }))
      .resolves.toEqual({ id: "environment-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/v1/environments/environment-1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("retrieves authenticated artifacts and uses the public artifact URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("evidence", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient(
      "http://api.internal/v1",
      "token",
      "https://scry.example/v1",
    );
    expect(client.artifactUrl("artifact id")).toBe(
      "https://scry.example/v1/artifacts/artifact%20id",
    );
    await expect(client.getArtifact("artifact id")).resolves.toMatchObject({
      contentType: "text/plain",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.internal/v1/artifacts/artifact%20id",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});
