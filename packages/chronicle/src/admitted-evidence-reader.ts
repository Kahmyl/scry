import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { EvidenceProtectionPort, EvidenceWriteAdmission } from "@scry/contracts";
import { decodeEvidenceChunk, evidenceDigest } from "./evidence-codec.js";
import {
  EvidenceArtifactFailure,
  isArtifactFilesystemFailure,
} from "./evidence-artifact-failure.js";

export interface EvidenceVerification<T> {
  events: T[];
  /** Authenticated chunk writer for each payload; never inferred from payload fields. */
  eventOwnerGenerations: number[];
  chunks: number;
  complete: boolean;
  gaps: Array<{ type: "partial_chunk"; name: string }>;
  lastDigest: string | null;
  lastSequence: number | null;
  plaintextBytes: number;
  storedBytes: number;
}

/** Read admitted objects only. No directory creation, writer initialization,
 * sequence allocation, orphan discovery or candidate promotion capability. */
export class AdmittedEvidenceReader<T> {
  constructor(
    private readonly options: {
      directory: string;
      runId: string;
      scopeId: string;
      protection: Pick<EvidenceProtectionPort, "decryptCompressed">;
      admission: Pick<EvidenceWriteAdmission, "readStream" | "assertActive">;
    },
  ) {}

  async verify(): Promise<EvidenceVerification<T>> {
    const { admission, protection, runId, scopeId, directory } = this.options;
    const snapshot = await admission.readStream();
    if (
      snapshot.custodyMode !== "admitted" ||
      snapshot.sessionId !== scopeId ||
      snapshot.runId !== runId
    )
      throw new Error("evidence_admission_scope_invalid");
    const events: T[] = [];
    const eventOwnerGenerations: number[] = [];
    let sequence = 0,
      previousDigest = "GENESIS",
      plaintextBytes = 0,
      storedBytes = 0;
    for (const [index, receipt] of snapshot.chunks.entries()) {
      if (
        receipt.chunkIndex !== index ||
        receipt.streamId !== snapshot.id ||
        receipt.previousDigest !== previousDigest ||
        !new RegExp(`^objects/${receipt.ownerGeneration}/[a-f0-9-]{36}\\.json$`).test(
          receipt.objectKey,
        )
      )
        throw new Error("evidence_receipt_invalid");
      const filename = path.join(directory, receipt.objectKey);
      let bytes: Buffer;
      try {
        for (const parent of [
          directory,
          path.dirname(path.dirname(filename)),
          path.dirname(filename),
        ])
          if (!(await lstat(parent)).isDirectory())
            throw new EvidenceArtifactFailure("object_unavailable");
        const handle = await open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new EvidenceArtifactFailure("object_unavailable");
          if (stat.size !== receipt.objectBytes)
            throw new EvidenceArtifactFailure("integrity_mismatch");
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isArtifactFilesystemFailure(error))
          throw new EvidenceArtifactFailure("object_unavailable");
        throw error;
      }
      if (bytes.length !== receipt.objectBytes || evidenceDigest([bytes]) !== receipt.objectDigest)
        throw new EvidenceArtifactFailure("integrity_mismatch");
      const decoded = (() => {
        try {
          return decodeEvidenceChunk<T>(bytes, protection, {
            runId,
            sessionId: scopeId,
            streamId: snapshot.id,
            ownerGeneration: receipt.ownerGeneration,
            chunk: index,
            previousDigest,
          });
        } catch {
          // The bytes match the admitted digest, but cannot be interpreted with
          // this capability. Do not assert malicious tampering or expose values.
          throw new EvidenceArtifactFailure("content_unverifiable");
        }
      })();
      if (
        decoded.record.digest !== receipt.digest ||
        decoded.plaintextBytes !== receipt.plaintextBytes ||
        decoded.storedBytes !== receipt.storedBytes ||
        decoded.record.aad.firstSequence !== receipt.firstSequence ||
        decoded.record.aad.lastSequence !== receipt.lastSequence
      )
        throw new EvidenceArtifactFailure("integrity_mismatch");
      for (const event of decoded.events) {
        if (event.sequence !== sequence++) throw new EvidenceArtifactFailure("integrity_mismatch");
        events.push(event.payload);
        eventOwnerGenerations.push(receipt.ownerGeneration);
      }
      previousDigest = receipt.digest;
      plaintextBytes += decoded.plaintextBytes;
      storedBytes += decoded.storedBytes;
      admission.assertActive();
    }
    if (
      snapshot.chunkCount !== snapshot.chunks.length ||
      snapshot.totalBytes !== storedBytes ||
      snapshot.chainHead !== (snapshot.chunks.length ? previousDigest : null)
    )
      throw new Error("evidence_receipt_summary_mismatch");
    return {
      events,
      eventOwnerGenerations,
      chunks: snapshot.chunks.length,
      complete: true,
      gaps: [],
      lastDigest: snapshot.chainHead,
      lastSequence: sequence ? sequence - 1 : null,
      plaintextBytes,
      storedBytes,
    };
  }
}
