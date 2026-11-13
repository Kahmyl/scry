import type {
  NativeCaptureEpoch,
  NativeCaptureSample,
  NativeImageEvidence,
  NativeImageReason,
} from "./native-privacy.js";

/** Private transport capability. History/graph values must never enter parent IPC. */
export interface NativeBrowserProtectionPort {
  fork(epoch: NativeCaptureEpoch): NativeBrowserProtectionPort;
  clean(value: unknown): unknown;
  cleanApi(value: unknown): unknown;
  prelearn(value: unknown): void;
  cleanTextContent(
    content: Array<{ type: string; text?: string }>,
    snapshot: boolean,
  ): Array<{ type: string; text?: string }>;
  readonly script: string;
  readonly scriptRevision: number;
  readonly policyGeneration: number;
  documentUpdatesSince(revision: number): Array<{ revision: number; script: string }>;
  readonly readExpression: string;
  readExpressionFor(source: { pageId: number; worldId: number }): string;
  beginImageCapture(pageId?: number): number;
  endImageCapture(token: number): void;
  readonly pixelExpression: string;
  beginNativeRead(finalReadChallenge?: string): number;
  acceptNativeRead(
    read: number,
    facts: unknown,
    source: { pageId: number; worldId: number },
  ): boolean;
  finishNativeRead(
    read: number,
    complete: boolean,
    selectedPage?: number,
    missingPageIds?: number[],
  ): boolean;
  acceptNativePaint(
    read: number,
    facts: unknown,
    source: { pageId: number; worldId: number },
  ): boolean;
  finishNativePaint(read: number): void;
  capacityExceeded(): void;
  observationAvailable(): boolean;
  observationIssue():
    | "native_protection_capacity"
    | "native_protection_refresh_incomplete"
    | "native_protection_classification_failed";
  imageEvidence(): NativeImageEvidence;
  captureSample(): NativeCaptureSample;
  acceptGap(payload: unknown): void;
  drainGaps(): NativeImageReason[];
  diagnosticDetailAllowed(): false;
  updateSecrets(values: Record<string, string>): void;
  dispose(): void;
}
