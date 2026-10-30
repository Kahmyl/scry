import type {
  BrowserCaptureReceipt,
  BrowserDisclosureMode,
  BrowserOutputSelection,
  BrowserProtectionDecision,
  BrowserProtectionSink,
  BrowserPublishedOutputs,
} from "./browser-execution.js";
import type {
  EvidenceCompletion,
  EvidenceProtectionPort,
  SafeActionLedgerEntry,
} from "./chronicle-ports.js";

export interface PraxisSessionScope {
  sessionId: string;
  runId: string;
  projectId: string;
  missionId: string;
  baseOrigin: string;
  ownerGeneration: number;
  disclosureMode: BrowserDisclosureMode;
  protectionKeyId: string;
}

export interface PraxisOwnerIdentity {
  sessionId: string;
  generation: number;
  leaseToken: string;
}

export interface PraxisOwnerLeaseSample {
  /** Database-relative authority, sampled only after coordination locks. */
  leaseRemainingMs: number;
  /** Private process-local monotonic query anchor, never persisted or public. */
  sampleStartedAt: number;
}
export interface PraxisOwnerClaim extends PraxisOwnerLeaseSample {
  generation: number;
  leaseToken: string;
  fencingToken: number;
}

/** Private runtime receipt, admitted only after exact custody and recording
 * drain settle. This is not a customer-provided command or a timeout claim. */
export interface PraxisOwnerRetirement {
  owner: PraxisOwnerIdentity;
  browserStopped: true;
  recordingDrained: true;
}

/** Serialized browser state, not a browser object or driver dependency. Additional
 * browser-provided fields (including IndexedDB) are preserved during persistence. */
export interface PraxisStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
    partitionKey?: string;
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}
export interface PraxisCheckpoint {
  resumeUrl: string;
  storageState: PraxisStorageState;
  sessionStorage: Record<string, string>;
}
export interface PraxisEffectFact extends Record<string, unknown> {
  id: string;
  session_id: string;
  dispatch_state: "not_started" | "started" | "acknowledged" | "unknown";
}
export interface PraxisEffectIntent {
  sessionId: string;
  ownerGeneration: number;
  documentEpoch: number;
  idempotencyKey: string;
  effectClass: "authentication" | "business";
  expectedOrigin: string;
  targetDigest: string;
  actionDigest: string;
  intentSummary: string;
}
export interface DurableCaptureEnvelope {
  captureId: string;
  storedReceipt: Record<string, unknown>;
  encryptedPayload: Buffer;
  encryptedPayloadDigest: string;
}
export interface CaptureEvidenceInput {
  effectId: string;
  ownerGeneration: number;
  captureId: string;
  evidenceFormat: number;
  objectKey: string;
  ciphertextDigest: string;
  authenticatedMetadata: Record<string, unknown>;
  contentClass: BrowserCaptureReceipt["contentClass"];
  byteSize: number;
  structuralIndex: unknown[];
  capturedAt: Date;
  expiresAt: Date;
  encryptedPayload: Buffer;
  encryptedPayloadDigest: string;
  responseStatus?: number;
}
export interface PraxisPublication {
  effectId: string;
  ownerGeneration: number;
  captureId: string;
  selectionDigest: string;
  publicOutputs: Record<string, string | number | boolean | null>;
  protectedOutputs: Record<string, string>;
  decisions: BrowserProtectionDecision[];
}

/** Application persistence/admission, not browser mechanics. */
export interface PraxisCommandsPort {
  sessionContext(sessionId: string): Promise<PraxisSessionScope>;
  protectedValuesForSession(sessionId: string): Promise<Record<string, string>>;
  publicValuesForSession(
    sessionId: string,
  ): Promise<Array<{ value: string; allowedSinks: BrowserProtectionSink[] }>>;
  protectedValueForBrowser(sessionId: string, protectedValueId: string): Promise<string>;
  loadBrowserCheckpoint(
    sessionId: string,
    generation: number,
  ): Promise<(PraxisCheckpoint & { revision: number }) | null>;
  saveBrowserCheckpoint(
    sessionId: string,
    generation: number,
    value: PraxisCheckpoint,
  ): Promise<{ revision: number }>;
  deleteBrowserCheckpoint(sessionId: string, generation: number): Promise<void>;
  safeActionLedger(sessionId: string): Promise<SafeActionLedgerEntry[]>;
  evidenceStatus(sessionId: string): Promise<import("./chronicle-ports.js").EvidenceStatus | null>;
}
export interface PraxisEffectsPort {
  assertOwner(owner: PraxisOwnerIdentity): Promise<void>;
  openEvidenceStream(
    owner: PraxisOwnerIdentity,
    runId: string,
  ): Promise<import("./chronicle-ports.js").EvidenceStreamSnapshot>;
  readEvidenceStream(
    owner: PraxisOwnerIdentity,
  ): Promise<import("./chronicle-ports.js").EvidenceStreamSnapshot>;
  admitEvidenceChunk(
    owner: PraxisOwnerIdentity,
    chunk: import("./chronicle-ports.js").EvidenceChunkReceipt,
  ): Promise<void>;
  startEvidenceCapture(owner: PraxisOwnerIdentity): Promise<void>;
  stopEvidenceCapture(
    owner: PraxisOwnerIdentity,
    receipt: { browserStopped: true; recordingDrained: true; recordingComplete: boolean },
  ): Promise<void>;
  completeEvidence(owner: PraxisOwnerIdentity, input: EvidenceCompletion): Promise<void>;
  assertCompatibleBaseline(): Promise<void>;
  claimOwner(sessionId: string, workerId: string, leaseMs: number): Promise<PraxisOwnerClaim>;
  heartbeatOwner(
    sessionId: string,
    generation: number,
    leaseToken: string,
    leaseMs: number,
  ): Promise<PraxisOwnerLeaseSample>;
  retireOwner(receipt: PraxisOwnerRetirement): Promise<void>;
  durableCapturesForSession(sessionId: string): Promise<DurableCaptureEnvelope[]>;
  prepareFailureFinalization(sessionId: string, generation: number): Promise<void>;
  assertNoPendingEffectOutcomes(sessionId: string): Promise<void>;
  unsettledCaptureIds(sessionId: string): Promise<string[]>;
  recoverAdmittedEffect(
    input: Pick<
      PraxisEffectIntent,
      "sessionId" | "idempotencyKey" | "effectClass" | "expectedOrigin" | "intentSummary"
    >,
  ): Promise<{ effectId: string } | null>;
  recoverEffect(effectId: string): Promise<Record<string, unknown>>;
  admitEffect(input: PraxisEffectIntent): Promise<{ effect: PraxisEffectFact; replay: boolean }>;
  markDispatchStarted(effectId: string, generation: number): Promise<PraxisEffectFact>;
  markUnknown(effectId: string, generation: number, reason: string): Promise<PraxisEffectFact>;
  determine(
    effectId: string,
    generation: number,
    outcome: "applied" | "not_applied" | "unknown",
    source: string,
  ): Promise<PraxisEffectFact>;
  registerCapture(input: CaptureEvidenceInput): Promise<void>;
  observeEffect(effectId: string): Promise<PraxisEffectFact>;
  assertCaptureSlotAvailable(effectId: string, sessionId: string): Promise<void>;
  publishOutputs(
    input: PraxisPublication,
  ): Promise<{ publicationId: string; protectedReferences: Record<string, string> }>;
  discardCapture(input: {
    effectId: string;
    ownerGeneration: number;
    captureId: string;
  }): Promise<void>;
}

export interface VeilBarrier {
  effectId: string;
  decisionRevision: number;
  scopeDigest: string;
}
export interface VeilBrowserAuthorityPort {
  begin(effectId: string): VeilBarrier;
  abort(token: VeilBarrier): void;
  sanitize(value: string, sink: BrowserProtectionSink): string;
}
export interface VeilBrowserCapturePort {
  captureHttpResponse(input: {
    effectId: string;
    method: string;
    url: string;
    status: number;
    contentType: string;
    body: Buffer;
    redirectChain?: Array<{ status: number; sameOrigin: boolean; targetDigest: string }>;
    protectionBarrier: VeilBarrier;
  }): Promise<BrowserCaptureReceipt>;
  exportDurableCapture(captureId: string): Promise<DurableCaptureEnvelope>;
  publish(
    captureId: string,
    selections: readonly BrowserOutputSelection[],
    options: { deferReleaseUntilDurablePublication: boolean },
  ): Promise<BrowserPublishedOutputs>;
  deliverProtectedToBrowser(
    reference: string,
    sink: { fill(value: string): Promise<void> },
  ): Promise<unknown>;
  releasePublishedBarrier(captureId: string): Promise<void>;
  discard(captureId: string): Promise<{ receipt: BrowserCaptureReceipt }>;
}
export interface VeilBrowserSessionPort {
  nativeProtectionScript: string;
  authority: VeilBrowserAuthorityPort;
  vault: VeilBrowserCapturePort;
  evidenceProtection: EvidenceProtectionPort;
  semanticHint(value: string): string;
  restoreCaptures(captures: DurableCaptureEnvelope[]): Promise<void>;
}
export interface VeilBrowserProtectionPort {
  readEvidence(
    scope: Pick<PraxisSessionScope, "runId" | "sessionId" | "protectionKeyId">,
  ): Pick<EvidenceProtectionPort, "decryptCompressed">;
  createSession(input: {
    scope: PraxisSessionScope;
    captureDirectory: string;
    protectedValues: Record<string, string>;
    restoredPublicValues: Array<{ value: string; allowedSinks: BrowserProtectionSink[] }>;
  }): VeilBrowserSessionPort;
}
