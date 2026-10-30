import type { Buffer } from "node:buffer";

export interface EvidenceChunkReceipt {
  streamId: string;
  ownerGeneration: number;
  chunkIndex: number;
  objectKey: string;
  objectDigest: string;
  objectBytes: number;
  digest: string;
  previousDigest: string;
  firstSequence: number;
  lastSequence: number;
  plaintextBytes: number;
  storedBytes: number;
}

export interface EvidenceStreamSnapshot {
  id: string;
  sessionId: string;
  runId: string;
  custodyMode: "legacy" | "admitted";
  state: "open" | "complete" | "incomplete" | "corrupt" | "expired";
  writerGeneration: number | null;
  chainHead: string | null;
  chunkCount: number;
  totalBytes: number;
  sealedAt: string | null;
  captureStartedAt: string | null;
  captureStoppedAt: string | null;
  captureComplete: boolean | null;
  interruptions: number;
  chunks: EvidenceChunkReceipt[];
}
export interface EvidenceStatus {
  state: EvidenceStreamSnapshot["state"];
  sealed: boolean;
  captureStarted: boolean;
  captureStopped: boolean;
  interruptions: number;
  custodyMode: "legacy" | "admitted";
  issue?: EvidenceClosureIssue;
}

export const evidenceClosureIssues = [
  "object_unavailable",
  "integrity_mismatch",
  "content_unverifiable",
  "video_unavailable",
  "publication_unavailable",
] as const;
export type EvidenceClosureIssue = (typeof evidenceClosureIssues)[number];

/** Fixed metadata operations only. No file, network, renderer or arbitrary
 * callback may execute while application ownership locks are held. */
export interface EvidenceWriteAdmission {
  readonly ownerGeneration: number;
  assertActive(): void;
  checkpoint(): Promise<void>;
  openStream(runId: string): Promise<EvidenceStreamSnapshot>;
  readStream(): Promise<EvidenceStreamSnapshot>;
  admitChunk(chunk: EvidenceChunkReceipt): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(receipt: {
    browserStopped: true;
    recordingDrained: true;
    recordingComplete: boolean;
  }): Promise<void>;
}

/** Veil supplies this capability; Chronicle never receives a master key. */
export interface EvidenceProtectionPort {
  encrypt(compressed: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer };
  decryptCompressed(aad: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer;
}
export type EvidenceReadProtectionPort = Pick<EvidenceProtectionPort, "decryptCompressed">;

export interface RecordingProtectionPort {
  /** Snapshot quarantine at receipt, before asynchronous processing can change it. */
  snapshot(): (value: unknown) => unknown;
}

export const recordingFailureCodes = [
  "recorder_missing",
  "recorder_payload_invalid",
  "recorder_write_failed",
  "recorder_attach_failed",
  "recorder_checkpoint_failed",
  "recorder_capture_failed",
  "recorder_navigation_reinstall_failed",
] as const;
export type RecordingFailureCode = (typeof recordingFailureCodes)[number];

export interface ChronicleRecordingDiagnostics {
  receivedEvents: number;
  errors: Array<{ code: RecordingFailureCode }>;
  diagnostics: Array<{ code: "owner_closed_during_capture" }>;
}

export interface ChronicleRecordingPort {
  receive(payload: string): void;
  recordError(code: RecordingFailureCode, error: unknown): void;
  flush(): Promise<ChronicleRecordingDiagnostics>;
  /** Permanently stop receipt, join admitted work and discard unflushed data.
   * This must not flush new evidence or authorize stream completion. */
  abort(): Promise<void>;
}

/** Native, already best-effort-masked pixels. No DOM or application values. */
export interface NativeMediaReceipt {
  masking?: "best_effort" | "unavailable";
  kind: "video" | "screenshot";
  objectKey: string;
  digest: string;
  bytes: number;
  timestamp: number;
  label: string;
  durationMs?: number;
}
export interface ChronicleNativeRecordingPort {
  maskingUnavailable(): void;
  readonly directory: string;
  admit(input: {
    filename: string;
    kind: NativeMediaReceipt["kind"];
    timestamp: number;
    label: string;
    durationMs?: number;
  }): Promise<void>;
  flush(): Promise<ChronicleRecordingDiagnostics>;
  abort(): Promise<void>;
  recordError(code: RecordingFailureCode, error: unknown): void;
}

export interface ChronicleReplayPlan {
  events: Array<Record<string, unknown>>;
  stagingDirectory: string;
  framesDirectory: string;
  frames: Array<{ renderOffset: number; caption: string }>;
  renderDurationMs: number;
  playbackRate: number;
  executablePath?: string;
}

export interface ChronicleReplayRendererPort {
  render(plan: ChronicleReplayPlan): Promise<{
    videoPath?: string;
    replayFailed: boolean;
    networkRequests: number;
    visibleFrameCount: number;
  }>;
}

interface EvidenceCompletionFacts {
  sessionId: string;
  runId: string;
  chainHead: string | null;
  chunkCount: number;
  totalBytes: number;
  videoObjectKey?: string;
}
export type EvidenceCompletion = EvidenceCompletionFacts &
  (
    | { state: "complete"; replayObjectKey: string; issue?: never }
    | { state: "incomplete"; replayObjectKey?: string; issue?: EvidenceClosureIssue }
  );

export interface SafeActionLedgerEntry {
  at: string;
  tool: string;
  outcome: string;
  durationMs: number;
}

interface ChronicleEvidenceScopeFacts {
  admission: EvidenceWriteAdmission;
  root: string;
  runId: string;
  sessionId: string;
  maxSessionBytes: number;
}
export type ChronicleEvidenceScope = ChronicleEvidenceScopeFacts &
  (
    | { purpose: "closure"; protection: EvidenceReadProtectionPort }
    | { purpose?: "capture"; protection: EvidenceProtectionPort }
  );

export interface ChronicleSealOptions {
  /** Only an explicit failed-run close may acknowledge missing derived evidence.
   * This never waives current-owner, capture-stop or admitted-receipt checks. */
  failureClosure?: boolean;
  renderVideo: boolean;
  actionLedger: () => Promise<SafeActionLedgerEntry[]>;
  executablePath?: string;
}

export interface ChronicleEvidenceSessionPort {
  createNativeRecording(): Promise<ChronicleNativeRecordingPort>;
  createRecording(protection: RecordingProtectionPort): ChronicleRecordingPort;
  startCapture(): Promise<void>;
  stopCapture(receipt: { browserStopped: true; recordingDrained: true }): Promise<void>;
  prepareClosure(): Promise<void>;
  seal(options: ChronicleSealOptions): Promise<EvidenceCompletion>;
}

export interface ChronicleEvidencePort {
  openSession(scope: ChronicleEvidenceScope): Promise<ChronicleEvidenceSessionPort>;
}

/** Supplied by application composition, including an existing transaction client. */
export interface ChronicleSqlPort {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}
