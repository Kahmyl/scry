import { randomUUID } from "node:crypto";
import type { EvidenceStreamSnapshot, EvidenceWriteAdmission } from "@scry/contracts";

/** A public-port recording/render mechanism double, not database custody proof.
 * Assurance must not import Chronicle's internal fixtures or implementation. */
export function recordingAdmission(sessionId: string, runId: string): EvidenceWriteAdmission {
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
  return {
    ownerGeneration: 1,
    assertActive() {},
    async checkpoint() {},
    async openStream() {
      return structuredClone(stream);
    },
    async readStream() {
      return structuredClone(stream);
    },
    async admitChunk(chunk) {
      if (
        chunk.streamId !== stream.id ||
        chunk.chunkIndex !== stream.chunkCount ||
        chunk.previousDigest !== (stream.chainHead ?? "GENESIS")
      )
        throw new Error("fixture_receipt_conflict");
      stream.chunks.push(structuredClone(chunk));
      stream.chainHead = chunk.digest;
      stream.chunkCount++;
      stream.totalBytes += chunk.storedBytes;
    },
    async startCapture() {
      stream.captureStartedAt = new Date().toISOString();
    },
    async stopCapture(receipt) {
      stream.captureStoppedAt = new Date().toISOString();
      stream.captureComplete = receipt.recordingComplete;
    },
  };
}
