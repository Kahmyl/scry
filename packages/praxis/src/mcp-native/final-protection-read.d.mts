import type {
  NativeCaptureEpoch,
  NativeCaptureSample,
  NativeFinalReadChallenge,
} from "@scry/contracts";

export function readFinalCaptureProtection(options: {
  /** Issued by Chronicle only after the exact physical capture has stopped. */
  finalRead: NativeFinalReadChallenge;
  epoch: NativeCaptureEpoch;
  read: (challenge: string) => Promise<unknown>;
  sample: () => NativeCaptureSample;
  /** Private reads/paint tasks still in flight; never treated as completed. */
  pending: () => readonly Promise<unknown>[];
  assertActive: () => void;
  signal?: AbortSignal;
}): Promise<{ retried: boolean }>;
