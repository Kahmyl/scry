import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  VEIL_CONTRACT_VERSION,
  veilCapturePermitSchema,
  type VeilCapturePermit,
  type VeilContext,
  type VeilVisualRegion,
} from "@scry/contracts";

export type VeilVisualCaptureBinding = Pick<
  VeilContext,
  "browserContextId" | "pageId" | "frameId" | "documentEpoch"
>;
export type VeilVisualMaskObservation = Readonly<{
  documentIdentity: string;
  revision: number;
  regions: readonly VeilVisualRegion[];
}>;
type StoredPermit = {
  permit: VeilCapturePermit;
  binding: VeilVisualCaptureBinding;
  observationDigest: string;
  state: "issued" | "captured";
};

export class VeilVisualCaptureError extends Error {
  override name = "VeilVisualCaptureError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Owns short-lived capture authorization and validates Praxis-observed mask facts. */
export class VeilVisualCaptureAuthority {
  private readonly permits = new Map<string, StoredPermit>();

  constructor(
    private readonly policyDigest: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 500,
  ) {
    if (!/^[a-f0-9]{64}$/.test(policyDigest))
      throw new VeilVisualCaptureError("VEIL_POLICY_INVALID", "A valid policy digest is required");
    if (!Number.isInteger(ttlMs) || ttlMs < 50 || ttlMs > 5_000)
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_TTL_INVALID",
        "Capture permit TTL must be between 50 and 5000ms",
      );
  }

  issue(
    observation: VeilVisualMaskObservation,
    binding: VeilVisualCaptureBinding,
  ): Readonly<{ permit: VeilCapturePermit; regions: readonly VeilVisualRegion[] }> {
    assertBinding(binding);
    assertObservation(observation);
    const issuedAt = this.now();
    const permit = veilCapturePermitSchema.parse({
      schemaVersion: VEIL_CONTRACT_VERSION,
      token: `veil_capture_${randomBytes(32).toString("base64url")}`,
      policyDigest: this.policyDigest,
      contextDigest: digest(binding),
      ...binding,
      maskDigest: digest(observation.regions),
      regionCount: observation.regions.length,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + this.ttlMs).toISOString(),
    });
    this.permits.set(permit.token, {
      permit,
      binding: { ...binding },
      observationDigest: digestObservation(observation),
      state: "issued",
    });
    return { permit, regions: observation.regions };
  }

  validate(
    observation: VeilVisualMaskObservation,
    rawPermit: VeilCapturePermit,
    binding: VeilVisualCaptureBinding,
  ): void {
    assertObservation(observation);
    const permit = veilCapturePermitSchema.parse(rawPermit);
    const stored = this.permits.get(permit.token);
    if (!stored || stored.state !== "issued" || !same(stored.permit, permit))
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_PERMIT_INVALID",
        "Capture permit is invalid, forged, or already used",
      );
    if (permit.policyDigest !== this.policyDigest)
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_POLICY_STALE",
        "Capture permit policy is stale",
      );
    if (this.now() >= Date.parse(permit.expiresAt))
      throw new VeilVisualCaptureError("VEIL_CAPTURE_PERMIT_EXPIRED", "Capture permit has expired");
    if (digest(binding) !== permit.contextDigest || digest(binding) !== digest(stored.binding))
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_CONTEXT_MISMATCH",
        "Capture permit does not match its browser facts",
      );
    if (
      digestObservation(observation) !== stored.observationDigest ||
      digest(observation.regions) !== permit.maskDigest
    ) {
      this.permits.delete(permit.token);
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_DOCUMENT_CHANGED",
        "Mask observation changed after permit issuance",
      );
    }
  }

  capture<T>(
    observation: VeilVisualMaskObservation,
    permit: VeilCapturePermit,
    binding: VeilVisualCaptureBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.validate(observation, permit, binding);
    return operation().then((result) => {
      const stored = this.permits.get(permit.token);
      if (!stored || stored.state !== "issued")
        throw new VeilVisualCaptureError(
          "VEIL_CAPTURE_PERMIT_INVALID",
          "Capture permit disappeared during capture",
        );
      stored.state = "captured";
      return result;
    });
  }

  revoke(permit: VeilCapturePermit): boolean {
    return this.permits.delete(permit.token);
  }

  admissionBinding(permit: VeilCapturePermit) {
    const stored = this.permits.get(permit.token);
    if (!stored || stored.state !== "captured" || !same(stored.permit, permit))
      throw new VeilVisualCaptureError(
        "VEIL_CAPTURE_NOT_COMPLETED",
        "Admission requires a consumed capture permit",
      );
    this.permits.delete(permit.token);
    return Object.freeze({
      capturePermitDigest: digest(permit),
      maskDigest: permit.maskDigest,
      documentEpoch: permit.documentEpoch,
    });
  }
}

function assertBinding(binding: VeilVisualCaptureBinding) {
  if (
    !binding.browserContextId ||
    !binding.pageId ||
    !binding.frameId ||
    !Number.isInteger(binding.documentEpoch) ||
    binding.documentEpoch < 0
  )
    throw new VeilVisualCaptureError(
      "VEIL_CAPTURE_CONTEXT_INVALID",
      "Capture binding is incomplete or invalid",
    );
}
function assertObservation(observation: VeilVisualMaskObservation) {
  if (!observation.documentIdentity || observation.regions.some((region) => !region.masked))
    throw new VeilVisualCaptureError(
      "VEIL_CAPTURE_MASK_UNPROVEN",
      "Every sensitive or unknown region must be proven masked",
    );
}
function digestObservation(observation: VeilVisualMaskObservation) {
  return digest({ documentIdentity: observation.documentIdentity, regions: observation.regions });
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
function same(left: VeilCapturePermit, right: VeilCapturePermit): boolean {
  const a = Buffer.from(stable(left));
  const b = Buffer.from(stable(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
