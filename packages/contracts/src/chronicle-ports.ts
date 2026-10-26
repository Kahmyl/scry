import type { Buffer } from "node:buffer";

/** The application holds its owner lock throughout each short durable write.
 * Rendering and browser/network operations must not run while holding this gate. */
export interface EvidenceWriteAdmission {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Veil supplies this capability; Chronicle never receives a master key. */
export interface EvidenceProtectionPort {
  encrypt(compressed: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer };
  decryptCompressed(aad: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer;
}

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

export interface EvidenceCompletion {
  sessionId: string;
  runId: string;
  chainHead: string;
  chunkCount: number;
  totalBytes: number;
  replayObjectKey: string;
  videoObjectKey?: string;
}

export interface SafeActionLedgerEntry {
  at: string;
  tool: string;
  outcome: string;
  durationMs: number;
}

export interface ChronicleEvidenceScope {
  admission: EvidenceWriteAdmission;
  root: string;
  runId: string;
  sessionId: string;
  protection: EvidenceProtectionPort;
  maxSessionBytes: number;
}

export interface ChronicleSealOptions {
  renderVideo: boolean;
  actionLedger: () => Promise<SafeActionLedgerEntry[]>;
  executablePath?: string;
}

export interface ChronicleEvidenceSessionPort {
  createRecording(protection: RecordingProtectionPort): ChronicleRecordingPort;
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
