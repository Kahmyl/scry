import type { Buffer } from "node:buffer";

/** Veil supplies this capability; Chronicle never receives a master key. */
export interface EvidenceProtectionPort {
  encrypt(compressed: Buffer, aad: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer };
  decryptCompressed(aad: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer;
}

export interface RecordingProtectionPort {
  /** Snapshot quarantine at receipt, before asynchronous processing can change it. */
  snapshot(): (value: unknown) => unknown;
}

export interface ChronicleRecordingDiagnostics {
  receivedEvents: number;
  errors: Array<{ code: string; message?: string }>;
  diagnostics: Array<{ code: string }>;
}

export interface ChronicleRecordingPort {
  receive(payload: string): void;
  recordError(code: string, error: unknown): void;
  flush(): Promise<ChronicleRecordingDiagnostics>;
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
