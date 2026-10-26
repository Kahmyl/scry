import { createHash } from "node:crypto";
import type { EvidenceProtectionPort } from "@scry/contracts";

export interface EvidenceEnvelope<T> {
  sequence: number;
  payload: T;
}
export interface EvidenceAad {
  evidenceFormat?: 1;
  evidenceVersion?: 1; // historical decoding only
  compression: "gzip";
  runId: string;
  scopeId: string;
  chunk: number;
  firstSequence: number;
  lastSequence: number;
  previousDigest: string;
  streamId?: string;
  ownerGeneration?: number;
}
export interface EncryptedChunk {
  aad: EvidenceAad;
  nonce: string;
  ciphertext: string;
  tag: string;
  digest: string;
}
export function evidenceDigest(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}
export function decodeEvidenceChunk<T>(
  bytes: Buffer,
  protection: EvidenceProtectionPort,
  scope: {
    runId: string;
    sessionId: string;
    chunk: number;
    previousDigest: string;
    streamId?: string;
    ownerGeneration?: number;
  },
) {
  let record: EncryptedChunk;
  try {
    record = JSON.parse(bytes.toString("utf8")) as EncryptedChunk;
  } catch {
    throw new Error("evidence_chunk_record_invalid");
  }
  if (
    !record?.aad ||
    (record.aad.evidenceFormat !== 1 && record.aad.evidenceVersion !== 1) ||
    record.aad.compression !== "gzip" ||
    record.aad.runId !== scope.runId ||
    record.aad.scopeId !== scope.sessionId ||
    record.aad.chunk !== scope.chunk ||
    record.aad.previousDigest !== scope.previousDigest ||
    (scope.streamId !== undefined && record.aad.streamId !== scope.streamId) ||
    (scope.ownerGeneration !== undefined && record.aad.ownerGeneration !== scope.ownerGeneration)
  )
    throw new Error("evidence_chunk_chain_invalid");
  const aad = Buffer.from(JSON.stringify(record.aad));
  const nonce = Buffer.from(record.nonce, "base64"),
    ciphertext = Buffer.from(record.ciphertext, "base64"),
    tag = Buffer.from(record.tag, "base64");
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    evidenceDigest([aad, nonce, ciphertext, tag]) !== record.digest
  )
    throw new Error("evidence_chunk_digest_invalid");
  const plaintext = protection.decryptCompressed(aad, nonce, ciphertext, tag);
  let events: Array<EvidenceEnvelope<T>>;
  try {
    const parsed = JSON.parse(plaintext.toString("utf8")) as {
      events?: Array<EvidenceEnvelope<T>>;
    };
    if (!Array.isArray(parsed.events) || !parsed.events.length) throw new Error("invalid");
    events = parsed.events;
  } catch {
    throw new Error("evidence_chunk_plaintext_invalid");
  }
  if (
    events[0]?.sequence !== record.aad.firstSequence ||
    events.at(-1)?.sequence !== record.aad.lastSequence
  )
    throw new Error("evidence_chunk_sequence_metadata_invalid");
  return { record, events, plaintextBytes: plaintext.length, storedBytes: ciphertext.length };
}
