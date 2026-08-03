import { describe, expect, it, vi } from "vitest";
import type { ArtifactStore, VeilEvidenceAdmissionProof } from "@scry/artifact";
import { ArtifactRetentionService } from "../src/artifacts/index.js";

const manifest = {
  schemaVersion: 1 as const,
  evidenceId: "11111111-1111-4111-8111-111111111111",
  channel: "report" as const,
  classification: "public" as const,
  disposition: "sanitize" as const,
  policyDigest: "a".repeat(64),
  decisionId: "decision-1",
  contentDigest: "b".repeat(64),
  omissionIntervals: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const due = (attempts = 1) => ({
  id: manifest.evidenceId,
  storageKey: "run/artifact",
  observation: {
    veilManifest: manifest,
    veilAdmissionToken: "token",
    veilSanitation: { scanner: "test" },
  },
  attempts,
  claimToken: "22222222-2222-4222-8222-222222222222",
});

function database(row = due()) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValue({ rows: [], rowCount: 1 });
  return { query };
}
function store(destroy: ArtifactStore["destroy"]): ArtifactStore {
  return {
    destroy,
    put: vi.fn(),
    get: vi.fn(),
    getRange: vi.fn(),
    size: vi.fn(),
    exists: vi.fn(),
    delete: vi.fn(),
  } as ArtifactStore;
}

describe("ArtifactRetentionService", () => {
  it.each(["deleted", "missing", "tampered"] as const)(
    "finalizes %s bytes without retaining proof material",
    async (outcome) => {
      const db = database();
      const destroy = vi.fn().mockResolvedValue({ outcome, bytesDestroyed: true });
      const results = await new ArtifactRetentionService(
        db as never,
        store(destroy),
        () => new Date("2026-01-02T00:00:00.000Z"),
      ).runBatch();
      expect(results).toEqual([
        { artifactId: manifest.evidenceId, status: "destroyed", outcome, attempts: 1 },
      ]);
      expect(destroy).toHaveBeenCalledWith(
        "run/artifact",
        expect.objectContaining({
          manifest,
          token: "token",
        }) satisfies Partial<VeilEvidenceAdmissionProof>,
      );
      expect(db.query.mock.calls[0]![0]).toContain("FOR UPDATE SKIP LOCKED");
      expect(db.query.mock.calls[1]![0]).toContain(
        "metadata - 'veilAdmissionToken' - 'veilManifest' - 'veilSanitation'",
      );
    },
  );

  it("fences concurrent completion with the claim token and schedules bounded retry", async () => {
    const db = database(due(4));
    const results = await new ArtifactRetentionService(
      db as never,
      store(vi.fn().mockRejectedValue(new Error("storage unavailable"))),
      () => new Date("2026-01-02T00:00:00.000Z"),
    ).runBatch();
    expect(results).toEqual([
      { artifactId: manifest.evidenceId, status: "retry", outcome: "storage_failure", attempts: 4 },
    ]);
    expect(db.query.mock.calls[1]![0]).toContain("destruction_claim_token=$2");
    expect(db.query.mock.calls[1]![1]).toEqual(expect.arrayContaining([16]));
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("storage unavailable");
  });

  it("is idle and idempotent when no artifact can be claimed", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const destroy = vi.fn();
    expect(
      await new ArtifactRetentionService({ query } as never, store(destroy)).runBatch(),
    ).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
