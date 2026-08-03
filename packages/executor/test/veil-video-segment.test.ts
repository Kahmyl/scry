import { describe, expect, it, vi } from "vitest";

import { VeilVideoSegmentAuthority } from "../src/veil-video-segment.js";

const policyDigest = "a".repeat(64);
const binding = { browserContextId: "context-1", pageId: "page-1", frameId: "main", documentEpoch: 7 } as const;

function visual() {
  let index = 0;
  return {
    issue: vi.fn(async () => ({ permit: { token: `capture-${++index}` }, regions: [] })),
    capture: vi.fn(async (_page, _permit, _binding, operation: () => Promise<unknown>) => operation()),
    admissionBinding: vi.fn((permit: { token: string }) => ({ capturePermitDigest: digestFor(permit.token), maskDigest: digestFor(`mask-${permit.token}`), documentEpoch: binding.documentEpoch })),
  };
}

describe("VeilVideoSegmentAuthority", () => {
  it("chains dynamic mask checkpoints and returns one consumable finalization", async () => {
    const masks = visual();
    const authority = new VeilVideoSegmentAuthority(policyDigest, masks as never);
    const permit = authority.issue("segment-1", binding);
    const first = await authority.checkpoint({} as never, permit, binding);
    const second = await authority.checkpoint({} as never, permit, binding);
    expect(first).toMatchObject({ sequence: 1, previousCheckpointDigest: null, documentEpoch: 7 });
    expect(second).toMatchObject({ sequence: 2, previousCheckpointDigest: first.checkpointDigest });
    expect(second.checkpointDigest).not.toBe(first.checkpointDigest);
    const finalization = authority.finalize(permit, binding);
    expect(finalization).toMatchObject({ segmentId: "segment-1", checkpointCount: 2, checkpointChainDigest: second.checkpointDigest, policyDigest });
    expect(() => authority.finalize(permit, binding)).toThrow(/forged, revoked, finalized/);
    expect(authority.consumeFinalization(finalization)).toEqual(finalization);
    expect(() => authority.consumeFinalization(finalization)).toThrow(/forged, unknown, or already consumed/);
    expect(masks.issue).toHaveBeenCalledTimes(2);
  });

  it("refuses caller-forged finalizations even when their schema is valid", async () => {
    const authority = new VeilVideoSegmentAuthority(policyDigest, visual() as never);
    const permit = authority.issue("segment-3", binding);
    await authority.checkpoint({} as never, permit, binding);
    const finalization = authority.finalize(permit, binding);
    expect(() => authority.consumeFinalization({ ...finalization, checkpointChainDigest: "b".repeat(64) })).toThrow(/forged, unknown/);
    expect(authority.consumeFinalization(finalization)).toEqual(finalization);
  });

  it("refuses finalization without a checkpoint and refuses forged, cross-context, and stale-epoch permits", async () => {
    const authority = new VeilVideoSegmentAuthority(policyDigest, visual() as never);
    const permit = authority.issue("segment-2", binding);
    expect(() => authority.finalize(permit, binding)).toThrow("without a visual mask checkpoint");
    await expect(authority.checkpoint({} as never, { ...permit, policyDigest: "b".repeat(64) }, binding)).rejects.toMatchObject({ code: "VEIL_VIDEO_PERMIT_INVALID" });
    await expect(authority.checkpoint({} as never, permit, { ...binding, pageId: "other" })).rejects.toMatchObject({ code: "VEIL_VIDEO_CONTEXT_MISMATCH" });
    await expect(authority.checkpoint({} as never, permit, { ...binding, documentEpoch: 8 })).rejects.toMatchObject({ code: "VEIL_VIDEO_CONTEXT_MISMATCH" });
  });

  it("expires and revokes segment authority fail closed", async () => {
    let now = 1_000;
    const authority = new VeilVideoSegmentAuthority(policyDigest, visual() as never, () => now, 1_000);
    const expired = authority.issue("expired", binding);
    now = 2_000;
    await expect(authority.checkpoint({} as never, expired, binding)).rejects.toMatchObject({ code: "VEIL_VIDEO_PERMIT_EXPIRED" });
    now = 3_000;
    const revoked = authority.issue("revoked", binding);
    expect(authority.revoke(revoked)).toBe(true);
    await expect(authority.checkpoint({} as never, revoked, binding)).rejects.toMatchObject({ code: "VEIL_VIDEO_PERMIT_INVALID" });
  });
});

function digestFor(value: string) { return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64); }
