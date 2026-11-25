/** Finite native privacy facts. These confer no credential or browser authority. */
export const nativeImageReasons = {
  native_protection_refresh_incomplete: "read_only_once",
  native_protection_geometry_stale: "read_only_once",
  native_protection_geometry_unsupported: "preserve_gap",
  native_protection_graph_capacity: "preserve_gap",
  native_protection_capacity: "preserve_gap",
  native_protection_classification_failed: "preserve_gap",
  native_protection_attestation_invalid: "preserve_gap",
} as const;

export type NativeImageReason = keyof typeof nativeImageReasons;
export type NativeImageEvidence =
  | { state: "available"; assessment: "best_effort_known_candidates" }
  | {
      [K in NativeImageReason]: {
        state: "withheld";
        reason: K;
        recovery: (typeof nativeImageReasons)[K];
      };
    }[NativeImageReason];

export type NativeCaptureEpoch = Readonly<{
  captureId: string;
  originalWriterGeneration: number;
  assessmentPolicyVersion: 2;
}>;
export type NativeCapturePolicySpan = Readonly<{
  first: number;
  last: number;
  transitions: number;
}>;

/** Cross-process carrier. Never add learned values, indices, labels or graph nodes. */
export type NativeCaptureSample = Readonly<{
  version: 1;
  readId: number;
  policyGeneration: number;
  finalReadChallenge?: string;
  text: "complete" | "withheld";
  image: NativeImageEvidence;
  knownRequirement: "present" | "absent_in_supported_snapshot" | "unknown";
  observedRequiredGap?: NativeImageReason;
}>;

export const nativeCaptureWithholdReasons = [
  ...(Object.keys(nativeImageReasons) as NativeImageReason[]),
  "native_capture_final_assessment_missing",
  "native_capture_identity_mismatch",
  "native_capture_policy_gap",
  "native_capture_bytes_mismatch",
  "native_capture_physical_receipt_missing",
  "native_capture_admission_unavailable",
] as const;
export type NativeCaptureWithholdReason = (typeof nativeCaptureWithholdReasons)[number];
export type RecordingGap = {
  captureId?: string;
  reason: NativeCaptureWithholdReason;
  affectedEvidence: "whole_capture";
  timing: "capture_bounds_only" | "unavailable";
  startedAtMs?: number;
  endedAtMs?: number;
  recoverable: false;
};
/** Safe informational projection, never media admission or a privacy override. */
export function canonicalRecordingGaps(value: unknown): RecordingGap[] | undefined {
  if (!Array.isArray(value)) return;
  return value.slice(0, 64).flatMap((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      !nativeCaptureWithholdReasons.includes(v.reason) ||
      v.affectedEvidence !== "whole_capture" ||
      v.recoverable !== false
    )
      return [];
    const timed =
      v.timing === "capture_bounds_only" &&
      Number.isSafeInteger(v.startedAtMs) &&
      v.startedAtMs >= 0 &&
      Number.isSafeInteger(v.endedAtMs) &&
      v.endedAtMs >= v.startedAtMs;
    return [
      {
        ...(typeof v.captureId === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.captureId)
          ? { captureId: v.captureId }
          : {}),
        reason: v.reason,
        affectedEvidence: "whole_capture" as const,
        timing: timed ? ("capture_bounds_only" as const) : ("unavailable" as const),
        ...(timed ? { startedAtMs: v.startedAtMs, endedAtMs: v.endedAtMs } : {}),
        recoverable: false as const,
      },
    ];
  });
}
export function recordingGapExplanation(reason: NativeCaptureWithholdReason): string {
  if (reason === "native_protection_geometry_unsupported")
    return "The masking system could not safely cover this page layout.";
  if (reason === "native_protection_classification_failed")
    return "The page's private-value observation could not be safely classified.";
  if (
    reason === "native_protection_refresh_incomplete" ||
    reason === "native_protection_geometry_stale"
  )
    return "A required privacy observation did not finish with current page geometry.";
  return "The recording's protection or capture proof was incomplete.";
}

/** Capture-bound best-effort assessment, never a continuous privacy certificate. */
export type NativeCaptureAssessment =
  | { state: "pending"; epoch: NativeCaptureEpoch; policy: NativeCapturePolicySpan }
  | {
      state: "best_effort_assessed";
      epoch: NativeCaptureEpoch;
      policy: NativeCapturePolicySpan;
      observedRequiredGap: false;
      latestSampledAssessment: NativeImageEvidence;
      warning: "automatic_redaction_best_effort";
    }
  | {
      state: "withheld";
      epoch: NativeCaptureEpoch;
      policy: NativeCapturePolicySpan;
      observedRequiredGap: boolean;
      reason: NativeCaptureWithholdReason;
    };

/** Aggregate: withheld means at least one capture gap; other media remain usable. */
export type RecordingAssessment =
  | { state: "pending" }
  | { state: "best_effort_assessed"; warning: "automatic_redaction_best_effort" }
  | {
      state: "withheld";
      reason: NativeCaptureWithholdReason;
      warning: "automatic_redaction_best_effort";
    };

/** Finite disclosure projection only, never authentication or policy derivation.
 * Unknown copy, values, paths, lineage and added payloads are not forwarded.
 */
export function canonicalRecordingAssessment(value: unknown): RecordingAssessment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  if (r.state === "pending") return { state: "pending" };
  if (r.warning !== "automatic_redaction_best_effort") return;
  if (r.state === "best_effort_assessed")
    return { state: "best_effort_assessed", warning: "automatic_redaction_best_effort" };
  if (
    r.state === "withheld" &&
    typeof r.reason === "string" &&
    (nativeCaptureWithholdReasons as readonly string[]).includes(r.reason)
  )
    return {
      state: "withheld",
      reason: r.reason as NativeCaptureWithholdReason,
      warning: "automatic_redaction_best_effort",
    };
}

export type NativePhysicalStopped = Readonly<{
  epoch: NativeCaptureEpoch;
  started: number;
  ended: number;
  physicalCoverage: "complete" | "partial";
}>;
export type NativeFinalReadChallenge = Readonly<{
  epoch: NativeCaptureEpoch;
  challenge: string;
}>;
export type NativeCaptureKind = "display" | "screencast";

/** Issued by Chronicle after registering graph/physical producers durably. */
export interface NativeCapturePort {
  readonly epoch: NativeCaptureEpoch;
  readonly directory: string;
  readonly filename: "recording.mp4" | "recording.webm";
  graphSample(input: Readonly<{ sequence: number; sample: NativeCaptureSample }>): Promise<void>;
  graphGap(input: Readonly<{ sequence: number; reason: NativeImageReason }>): Promise<void>;
  /** Owned recorder receipt; Chronicle measures bytes in the reserved directory. */
  physicalStopped(receipt: NativePhysicalStopped): Promise<NativeFinalReadChallenge>;
  graphClosed(input: Readonly<{ lastSequence: number }>): Promise<void>;
  policyTransition(
    input: Readonly<{ from: number; to: number; acknowledged: boolean }>,
  ): Promise<void>;
  seal(): Promise<Exclude<NativeCaptureAssessment, { state: "pending" }>>;
}
export type NativeCaptureRecovery = {
  admitted: number;
  recordingAssessment?: RecordingAssessment;
};

/** A failed recorder constructor can still leave unconfirmed physical resources. */
export type NativePhysicalRetirementUnconfirmed = {
  code: "RECORDER_RETIREMENT_UNCONFIRMED";
  physicalRetirement: "unconfirmed";
  mayOwnResources: true;
};
