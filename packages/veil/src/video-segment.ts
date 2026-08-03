import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  VEIL_CONTRACT_VERSION,
  veilVideoMaskCheckpointSchema,
  veilVideoSegmentFinalizationSchema,
  veilVideoSegmentPermitSchema,
  type VeilCapturePermit,
  type VeilContext,
  type VeilVideoMaskCheckpoint,
  type VeilVideoSegmentFinalization,
  type VeilVideoSegmentPermit,
} from "@scry/contracts";
import type { Page } from "playwright";

import { VeilVisualCaptureAuthority } from "./visual-capture.js";

export type VeilVideoSegmentBinding = Pick<
  VeilContext,
  "browserContextId" | "pageId" | "frameId" | "documentEpoch"
>;

type VisualAuthority = Pick<VeilVisualCaptureAuthority, "issue" | "capture" | "admissionBinding">;
type SegmentState = {
  permit: VeilVideoSegmentPermit;
  binding: VeilVideoSegmentBinding;
  checkpoints: VeilVideoMaskCheckpoint[];
};

export class VeilVideoSegmentError extends Error {
  override name = "VeilVideoSegmentError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Authorizes one continuous video segment and produces a tamper-evident chain
 * of Veil-owned visual-mask checkpoints. A finalization is consumable once and
 * is the only value suitable for binding future video admission.
 */
export class VeilVideoSegmentAuthority {
  private readonly segments = new Map<string, SegmentState>();
  private readonly finalized = new Map<string, VeilVideoSegmentFinalization>();

  constructor(
    private readonly policyDigest: string,
    private readonly visual: VisualAuthority = new VeilVisualCaptureAuthority(policyDigest),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {
    if (!/^[a-f0-9]{64}$/.test(policyDigest))
      throw new VeilVideoSegmentError("VEIL_POLICY_INVALID", "A valid policy digest is required");
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 1_800_000)
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_TTL_INVALID",
        "Video segment TTL must be between 1 second and 30 minutes",
      );
  }

  issue(segmentId: string, binding: VeilVideoSegmentBinding): VeilVideoSegmentPermit {
    assertBinding(binding);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(segmentId))
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_SEGMENT_ID_INVALID",
        "Video segment id is invalid",
      );
    const issuedAt = this.now();
    const permit = veilVideoSegmentPermitSchema.parse({
      schemaVersion: VEIL_CONTRACT_VERSION,
      token: `veil_video_${randomBytes(32).toString("base64url")}`,
      segmentId,
      policyDigest: this.policyDigest,
      contextDigest: digest(binding),
      ...binding,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    });
    this.segments.set(permit.token, { permit, binding: { ...binding }, checkpoints: [] });
    return permit;
  }

  async checkpoint(
    page: Page,
    rawPermit: VeilVideoSegmentPermit,
    binding: VeilVideoSegmentBinding,
  ): Promise<VeilVideoMaskCheckpoint> {
    const state = this.requireActive(rawPermit, binding);
    const { permit: capturePermit } = await this.visual.issue(page, binding);
    await this.visual.capture(page, capturePermit, binding, async () => undefined);
    const capture = this.visual.admissionBinding(capturePermit);
    const previous = state.checkpoints.at(-1)?.checkpointDigest ?? null;
    const unsigned = {
      schemaVersion: VEIL_CONTRACT_VERSION,
      segmentId: state.permit.segmentId,
      sequence: state.checkpoints.length + 1,
      documentEpoch: binding.documentEpoch,
      capturePermitDigest: capture.capturePermitDigest,
      maskDigest: capture.maskDigest,
      previousCheckpointDigest: previous,
      observedAt: new Date(this.now()).toISOString(),
    } as const;
    const checkpoint = veilVideoMaskCheckpointSchema.parse({
      ...unsigned,
      checkpointDigest: digest(unsigned),
    });
    state.checkpoints.push(checkpoint);
    return Object.freeze({ ...checkpoint });
  }

  finalize(
    rawPermit: VeilVideoSegmentPermit,
    binding: VeilVideoSegmentBinding,
  ): VeilVideoSegmentFinalization {
    const state = this.requireActive(rawPermit, binding);
    const checkpointChainDigest = state.checkpoints.at(-1)?.checkpointDigest;
    if (!checkpointChainDigest)
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_CHECKPOINT_REQUIRED",
        "A video segment cannot be finalized without a visual mask checkpoint",
      );
    this.segments.delete(state.permit.token);
    const finalization = Object.freeze(
      veilVideoSegmentFinalizationSchema.parse({
        schemaVersion: VEIL_CONTRACT_VERSION,
        segmentId: state.permit.segmentId,
        segmentPermitDigest: digest(state.permit),
        policyDigest: this.policyDigest,
        contextDigest: state.permit.contextDigest,
        documentEpoch: state.permit.documentEpoch,
        checkpointCount: state.checkpoints.length,
        checkpointChainDigest,
        finalizedAt: new Date(this.now()).toISOString(),
      }),
    );
    this.finalized.set(finalization.segmentPermitDigest, finalization);
    return finalization;
  }

  /** Authenticates and consumes a finalization exactly once at admission. */
  consumeFinalization(raw: VeilVideoSegmentFinalization): VeilVideoSegmentFinalization {
    const finalization = veilVideoSegmentFinalizationSchema.parse(raw);
    const stored = this.finalized.get(finalization.segmentPermitDigest);
    if (!stored || !sameFinalization(stored, finalization))
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_FINALIZATION_INVALID",
        "Video finalization is forged, unknown, or already consumed",
      );
    this.finalized.delete(finalization.segmentPermitDigest);
    return Object.freeze({ ...stored });
  }

  revoke(permit: VeilVideoSegmentPermit): boolean {
    return this.segments.delete(permit.token);
  }

  private requireActive(
    rawPermit: VeilVideoSegmentPermit,
    binding: VeilVideoSegmentBinding,
  ): SegmentState {
    const permit = veilVideoSegmentPermitSchema.parse(rawPermit);
    const state = this.segments.get(permit.token);
    if (!state || !same(permit, state.permit))
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_PERMIT_INVALID",
        "Video segment permit is forged, revoked, finalized, or unknown",
      );
    if (permit.policyDigest !== this.policyDigest)
      throw new VeilVideoSegmentError("VEIL_VIDEO_POLICY_STALE", "Video segment policy is stale");
    if (this.now() >= Date.parse(permit.expiresAt))
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_PERMIT_EXPIRED",
        "Video segment permit has expired",
      );
    if (digest(binding) !== permit.contextDigest || digest(binding) !== digest(state.binding))
      throw new VeilVideoSegmentError(
        "VEIL_VIDEO_CONTEXT_MISMATCH",
        "Video segment permit does not match context or document epoch",
      );
    return state;
  }
}

function assertBinding(binding: VeilVideoSegmentBinding) {
  if (
    !binding.browserContextId ||
    !binding.pageId ||
    !binding.frameId ||
    !Number.isInteger(binding.documentEpoch) ||
    binding.documentEpoch < 0
  )
    throw new VeilVideoSegmentError(
      "VEIL_VIDEO_CONTEXT_INVALID",
      "Video segment binding is incomplete or invalid",
    );
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function same(left: VeilVideoSegmentPermit, right: VeilVideoSegmentPermit): boolean {
  const a = Buffer.from(stable(left));
  const b = Buffer.from(stable(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function sameFinalization(
  left: VeilVideoSegmentFinalization,
  right: VeilVideoSegmentFinalization,
): boolean {
  const a = Buffer.from(stable(left));
  const b = Buffer.from(stable(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
