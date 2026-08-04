import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactStorageConfigurationError,
  RemoteArtifactStore,
  createArtifactStoreFromEnv,
  signVeilEvidenceAdmission,
  type RemoteObjectBackend,
} from "../src/index.js";

const admissionKey = "storage-adapter-admission-key-at-least-32-bytes";

describe("artifact storage configuration", () => {
  it("defaults to local storage and fails closed for unknown providers", () => {
    expect(createArtifactStoreFromEnv({}, admissionKey)).toMatchObject({
      provider: "local",
      remote: false,
    });
    expect(() =>
      createArtifactStoreFromEnv({ ARTIFACT_STORAGE_PROVIDER: "ftp" }, admissionKey),
    ).toThrow(ArtifactStorageConfigurationError);
  });

  it.each([
    ["s3", { ARTIFACT_S3_BUCKET: "bucket" }],
    ["cloudinary", { CLOUDINARY_CLOUD_NAME: "cloud" }],
    ["gcs", { ARTIFACT_GCS_BUCKET: "bucket", GOOGLE_CLOUD_PROJECT: "project" }],
  ])("rejects incomplete %s credentials before any I/O", (provider, values) => {
    expect(() =>
      createArtifactStoreFromEnv({ ARTIFACT_STORAGE_PROVIDER: provider, ...values }, admissionKey),
    ).toThrow(ArtifactStorageConfigurationError);
  });

  it("accepts a generic S3-compatible endpoint for self-hosted storage", () => {
    const configured = createArtifactStoreFromEnv(
      {
        ARTIFACT_STORAGE_PROVIDER: "s3",
        ARTIFACT_S3_BUCKET: "evidence",
        ARTIFACT_S3_REGION: "us-east-1",
        ARTIFACT_S3_ACCESS_KEY_ID: "access",
        ARTIFACT_S3_SECRET_ACCESS_KEY: "secret",
        ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:9000",
      },
      admissionKey,
    );
    expect(configured).toMatchObject({ provider: "s3", remote: true });
  });

  it("fails closed when production requires unconfirmed remote versioning", () => {
    expect(() =>
      createArtifactStoreFromEnv(
        {
          ARTIFACT_STORAGE_PROVIDER: "s3",
          ARTIFACT_S3_BUCKET: "evidence",
          ARTIFACT_S3_REGION: "us-east-1",
          ARTIFACT_S3_ACCESS_KEY_ID: "access",
          ARTIFACT_S3_SECRET_ACCESS_KEY: "secret",
          ARTIFACT_STORE_VERSIONING_REQUIRED: "true",
          ARTIFACT_STORE_VERSIONING_CONFIRMED: "false",
        },
        admissionKey,
      ),
    ).toThrow("versioning and retention confirmation");
  });
});

describe("remote artifact authority", () => {
  it("admits, verifies, ranges, quarantines, and destroys through one backend", async () => {
    const backend = memoryBackend();
    const store = new RemoteArtifactStore(backend, admissionKey, "tenant-a");
    const content = new TextEncoder().encode("sanitized evidence");
    const proof = signVeilEvidenceAdmission(
      manifest("11111111-1111-4111-8111-111111111111", content),
      admissionKey,
      { method: "test" },
    );
    await store.put("run/evidence.txt", content, proof);
    expect(new TextDecoder().decode(await store.getRange("run/evidence.txt", 10, 8, proof))).toBe(
      "evidence",
    );
    expect(await store.size("run/evidence.txt", proof)).toBe(content.byteLength);
    expect(backend.putObject).toHaveBeenCalledWith(
      "tenant-a/run/evidence.txt",
      content,
      expect.objectContaining({ "scry-evidence-id": "11111111-1111-4111-8111-111111111111" }),
    );
    expect(await store.destroy("run/evidence.txt", proof)).toEqual({
      outcome: "deleted",
      bytesDestroyed: true,
    });
    expect(await store.exists("run/evidence.txt")).toBe(false);
  });

  it("never serves a range when signed admission and stored checksum disagree", async () => {
    const backend = memoryBackend();
    const store = new RemoteArtifactStore(backend, admissionKey);
    const content = new TextEncoder().encode("first");
    const proof = signVeilEvidenceAdmission(
      manifest("22222222-2222-4222-8222-222222222222", content),
      admissionKey,
    );
    await store.put("evidence", content, proof);
    backend.objects.get("evidence")!.metadata["scry-sha256"] = "0".repeat(64);
    await expect(store.getRange("evidence", 0, 1, proof)).rejects.toThrow("checksum metadata");
    expect(backend.getObject).not.toHaveBeenCalled();
  });
});

function manifest(evidenceId: string, content: Uint8Array) {
  return {
    schemaVersion: 1 as const,
    evidenceId,
    channel: "screenshot" as const,
    classification: "public" as const,
    disposition: "sanitize" as const,
    policyDigest: "a".repeat(64),
    decisionId: "decision",
    contentDigest: createHash("sha256").update(content).digest("hex"),
    omissionIntervals: [],
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

function memoryBackend() {
  const objects = new Map<string, { content: Uint8Array; metadata: Record<string, string> }>();
  const backend = {
    objects,
    putObject: vi.fn(
      async (key: string, content: Uint8Array, metadata: Readonly<Record<string, string>>) => {
        objects.set(key, { content: content.slice(), metadata: { ...metadata } });
      },
    ),
    getObject: vi.fn(async (key: string, range?: { offset: number; length: number }) => {
      const value = objects.get(key);
      if (!value) throw new Error("missing");
      return range
        ? value.content.slice(range.offset, range.offset + range.length)
        : value.content.slice();
    }),
    headObject: vi.fn(async (key: string) => {
      const value = objects.get(key);
      if (!value) throw new Error("missing");
      return {
        sizeBytes: value.content.byteLength,
        checksumSha256: value.metadata["scry-sha256"]!,
      };
    }),
    existsObject: vi.fn(async (key: string) => objects.has(key)),
    deleteObject: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  } satisfies RemoteObjectBackend & { objects: typeof objects };
  return backend;
}
