import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalArtifactStore, signVeilEvidenceAdmission } from "@scry/artifact";
import { describe, expect, it, vi } from "vitest";

import { ArtifactService } from "../src/artifacts/index.js";

function admission(id: string, content: Uint8Array) {
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    schemaVersion: 1 as const,
    evidenceId: id,
    channel: "dom" as const,
    classification: "public" as const,
    disposition: "sanitize" as const,
    policyDigest: "a".repeat(64),
    decisionId: "decision-1",
    contentDigest: digest,
    omissionIntervals: [],
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

describe("ArtifactService", () => {
  const key = "test-admission-key-that-is-at-least-32-bytes";
  const sanitation = {
    stage: "post_capture",
    method: "SecretRedactor.redact",
    attestedAt: "2026-08-03T00:00:00.000Z",
  };
  it("refuses metadata and bytes for quarantined artifacts", async () => {
    process.env.VEIL_ADMISSION_KEY = key;
    const repository = {
      getArtifact: vi.fn().mockResolvedValue({
        id: "quarantined",
        availability: "quarantined",
        contentType: "video/webm",
      }),
    };
    const service = new ArtifactService(repository as never, {} as never);
    await expect(
      service.range({ kind: "service", subject: "scry-service" }, "quarantined"),
    ).rejects.toThrow("Artifact is not available");
  });

  it("refuses retrieval as soon as retention destruction is claimed", async () => {
    process.env.VEIL_ADMISSION_KEY = key;
    const repository = {
      getArtifact: vi.fn().mockResolvedValue({
        id: "claimed",
        availability: "available",
        destructionStatus: "deleting",
        storageKey: "run/claimed",
        contentType: "text/plain",
      }),
    };
    await expect(
      new ArtifactService(repository as never, {} as never).range(
        { kind: "service", subject: "scry-service" },
        "claimed",
      ),
    ).rejects.toThrow("Artifact is not available");
  });

  it("pages, searches, extracts, and ranges large text artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scry-artifact-v2-"));
    process.env.ARTIFACT_ROOT = root;
    process.env.VEIL_ADMISSION_KEY = key;
    const store = new LocalArtifactStore(root, key);
    const html = `<main id="docs"><section data-testid="orders">Order schema needle</section></main>${"x".repeat(100_000)}`;
    const content = new TextEncoder().encode(html);
    const proof = admission("11111111-1111-4111-8111-111111111111", content);
    await store.put("run/docs.html", content, signVeilEvidenceAdmission(proof, key, sanitation));
    const repository = {
      getArtifact: vi.fn().mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        availability: "available",
        destructionStatus: "pending",
        storageKey: "run/docs.html",
        contentType: "text/html",
        checksumSha256: proof.contentDigest,
        observation: {
          veilManifest: proof,
          veilSanitation: sanitation,
          veilAdmissionToken: signVeilEvidenceAdmission(proof, key, sanitation).token,
        },
      }),
    };
    const service = new ArtifactService(repository as never, store);
    const page = await service.text(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
      0,
      32,
    );
    expect(page.eof).toBe(false);
    expect(page.nextOffset).toBe(32);
    const search = await service.search(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
      "needle",
    );
    expect(search.matches).toHaveLength(1);
    const extraction = await service.extractHtml(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
      '[data-testid="orders"]',
    );
    expect(extraction.matches[0]?.html).toContain("Order schema needle");
    expect(extraction.matches[0]?.text).toBe("Order schema needle");
    const range = await service.range(
      { kind: "service", subject: "scry-service" },
      "11111111-1111-4111-8111-111111111111",
      "bytes=6-14",
    );
    expect(new TextDecoder().decode(range.data)).toBe('id="docs"');
  });

  it("extracts the complete nested element instead of stopping at the first nested closing tag", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scry-artifact-nested-"));
    process.env.ARTIFACT_ROOT = root;
    process.env.VEIL_ADMISSION_KEY = key;
    const store = new LocalArtifactStore(root, key);
    const html = `<section id="authentication"><div><div>Authentication</div></div><p>Use both headers.</p></section><section>after</section>`;
    const content = new TextEncoder().encode(html);
    const proof = admission("22222222-2222-4222-8222-222222222222", content);
    await store.put("run/nested.html", content, signVeilEvidenceAdmission(proof, key, sanitation));
    const repository = {
      getArtifact: vi.fn().mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        availability: "available",
        destructionStatus: "pending",
        storageKey: "run/nested.html",
        contentType: "text/html",
        checksumSha256: proof.contentDigest,
        observation: {
          veilManifest: proof,
          veilSanitation: sanitation,
          veilAdmissionToken: signVeilEvidenceAdmission(proof, key, sanitation).token,
        },
      }),
    };
    const service = new ArtifactService(repository as never, store);
    const extraction = await service.extractHtml(
      { kind: "service", subject: "scry-service" },
      "22222222-2222-4222-8222-222222222222",
      "#authentication",
    );
    expect(extraction.matches).toEqual([
      expect.objectContaining({
        html: expect.stringContaining("Use both headers."),
        text: "Authentication Use both headers.",
      }),
    ]);
    expect(extraction.matches[0]?.html).not.toContain("after");
  });

  it("returns a typed client error for unsupported selectors", async () => {
    const repository = { getArtifact: vi.fn() };
    const service = new ArtifactService(repository as never, {} as never);

    await expect(
      service.extractHtml(
        { kind: "service", subject: "scry-service" },
        "33333333-3333-4333-8333-333333333333",
        "header button",
      ),
    ).rejects.toMatchObject({
      response: {
        code: "ARTIFACT_SELECTOR_UNSUPPORTED",
        message: 'Selector must be a tag, #id, .class, or [data-testid="value"]',
      },
      status: 400,
    });
    expect(repository.getArtifact).not.toHaveBeenCalled();
  });
});
