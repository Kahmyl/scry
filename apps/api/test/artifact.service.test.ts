import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalArtifactStore } from "@scry/artifact";
import { describe, expect, it, vi } from "vitest";

import { ArtifactService } from "../src/artifact.service.js";

describe("ArtifactService", () => {
  it("refuses metadata and bytes for quarantined artifacts", async () => {
    const repository = { getArtifact: vi.fn().mockResolvedValue({ id: "quarantined", availability: "quarantined", contentType: "video/webm" }) };
    const service = new ArtifactService(repository as never);
    await expect(service.range({ kind: "service", subject: "scry-service" }, "quarantined")).rejects.toThrow("Artifact is not available");
  });

  it("pages, searches, extracts, and ranges large text artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scry-artifact-v2-"));
    process.env.ARTIFACT_ROOT = root;
    const store = new LocalArtifactStore(root);
    const html = `<main id="docs"><section data-testid="orders">Order schema needle</section></main>${"x".repeat(100_000)}`;
    await store.put("run/docs.html", new TextEncoder().encode(html));
    const repository = { getArtifact: vi.fn().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111", availability: "available", storageKey: "run/docs.html", contentType: "text/html",
    }) };
    const service = new ArtifactService(repository as never);
    const page = await service.text({ kind: "service", subject: "scry-service" }, "11111111-1111-4111-8111-111111111111", 0, 32);
    expect(page.eof).toBe(false);
    expect(page.nextOffset).toBe(32);
    const search = await service.search({ kind: "service", subject: "scry-service" }, "11111111-1111-4111-8111-111111111111", "needle");
    expect(search.matches).toHaveLength(1);
    const extraction = await service.extractHtml({ kind: "service", subject: "scry-service" }, "11111111-1111-4111-8111-111111111111", "[data-testid=\"orders\"]");
    expect(extraction.matches[0]?.html).toContain("Order schema needle");
    expect(extraction.matches[0]?.text).toBe("Order schema needle");
    const range = await service.range({ kind: "service", subject: "scry-service" }, "11111111-1111-4111-8111-111111111111", "bytes=6-14");
    expect(new TextDecoder().decode(range.data)).toBe("id=\"docs\"");
  });

  it("extracts the complete nested element instead of stopping at the first nested closing tag", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scry-artifact-nested-"));
    process.env.ARTIFACT_ROOT = root;
    const store = new LocalArtifactStore(root);
    const html = `<section id="authentication"><div><div>Authentication</div></div><p>Use both headers.</p></section><section>after</section>`;
    await store.put("run/nested.html", new TextEncoder().encode(html));
    const repository = { getArtifact: vi.fn().mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222", availability: "available", storageKey: "run/nested.html", contentType: "text/html",
    }) };
    const service = new ArtifactService(repository as never);
    const extraction = await service.extractHtml({ kind: "service", subject: "scry-service" }, "22222222-2222-4222-8222-222222222222", "#authentication");
    expect(extraction.matches).toEqual([expect.objectContaining({
      html: expect.stringContaining("Use both headers."),
      text: "Authentication Use both headers.",
    })]);
    expect(extraction.matches[0]?.html).not.toContain("after");
  });
});
