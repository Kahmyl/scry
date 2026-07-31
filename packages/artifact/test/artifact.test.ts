import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "../src/index.js";

describe("LocalArtifactStore", () => {
  it("stores bytes with stable metadata", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")));
    const result = await store.put("run/trace.zip", new TextEncoder().encode("evidence"));
    expect(result.sizeBytes).toBe(8);
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new TextDecoder().decode(await store.get("run/trace.zip"))).toBe("evidence");
  });

  it("rejects traversal keys", async () => {
    const store = new LocalArtifactStore(await mkdtemp(path.join(tmpdir(), "scry-artifact-")));
    await expect(store.put("../secret", new Uint8Array())).rejects.toThrow("safe relative");
  });
});
