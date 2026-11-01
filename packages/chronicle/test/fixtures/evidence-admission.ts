import { randomUUID } from "node:crypto";
import type {
  EvidenceChunkReceipt,
  EvidenceStreamSnapshot,
  EvidenceWriteAdmission,
} from "@scry/contracts";

/** Component-only port double. Database concurrency/clock/rollback authority is
 * exercised separately against the actual application repository. */
export function memoryAdmission(
  sessionId = "fixture-session",
  runId = "00000000-0000-4000-8000-000000000301",
) {
  const stream: EvidenceStreamSnapshot = {
    id: randomUUID(),
    sessionId,
    runId,
    custodyMode: "admitted",
    state: "open",
    writerGeneration: 1,
    chainHead: null,
    chunkCount: 0,
    totalBytes: 0,
    sealedAt: null,
    captureStartedAt: null,
    captureStoppedAt: null,
    captureComplete: null,
    interruptions: 0,
    chunks: [],
  };
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("SCRY_BROWSER_OWNER_FENCED");
  };
  const admission: EvidenceWriteAdmission = {
    ownerGeneration: 1,
    assertActive,
    async checkpoint() {
      assertActive();
    },
    async openStream(requestedRun) {
      assertActive();
      if (requestedRun !== runId) throw new Error("scope_mismatch");
      return structuredClone(stream);
    },
    async readStream() {
      assertActive();
      return structuredClone(stream);
    },
    async admitChunk(chunk: EvidenceChunkReceipt) {
      assertActive();
      if (
        stream.captureStoppedAt ||
        chunk.chunkIndex !== stream.chunkCount ||
        chunk.streamId !== stream.id ||
        chunk.previousDigest !== (stream.chainHead ?? "GENESIS") ||
        chunk.firstSequence !== (stream.chunks.at(-1)?.lastSequence ?? -1) + 1
      )
        throw new Error("receipt_conflict");
      stream.chunks.push(structuredClone(chunk));
      stream.chainHead = chunk.digest;
      stream.chunkCount++;
      stream.totalBytes += chunk.storedBytes;
    },
    async startCapture() {
      assertActive();
      stream.captureStartedAt = new Date().toISOString();
    },
    async stopCapture(receipt) {
      assertActive();
      stream.captureStoppedAt = new Date().toISOString();
      stream.captureComplete = receipt.recordingComplete;
      if (!receipt.recordingComplete) stream.interruptions++;
    },
  };
  return {
    admission,
    stream,
    revoke() {
      active = false;
    },
  };
}
