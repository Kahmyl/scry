import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type {
  EvidenceChunkReceipt,
  EvidenceProtectionPort,
  EvidenceWriteAdmission,
} from "@scry/contracts";
import { ensurePrivateDirectory } from "./durable-file.js";
import {
  evidenceDigest,
  type EvidenceAad,
  type EvidenceEnvelope,
  type EncryptedChunk,
} from "./evidence-codec.js";

import { AdmittedEvidenceReader, type EvidenceVerification } from "./admitted-evidence-reader.js";
export type { EvidenceVerification } from "./admitted-evidence-reader.js";

/** Files are candidates, not authority. Slow filesystem/codec work never holds
 * ownership locks. Only exact admitted SQL receipts are read or recovered. */
export class AdmittedEvidenceStore<T> {
  #directory: string;
  #pending: Array<EvidenceEnvelope<T>> = [];
  #pendingBytes = 0;
  #nextSequence = 0;
  #busy = false;
  #state: "new" | "initializing" | "ready" = "new";
  readonly #maxChunkBytes: number;
  readonly #maxSessionBytes: number;
  readonly #maxRawEventBytes: number;
  constructor(
    private readonly options: {
      directory: string;
      runId: string;
      scopeId: string;
      protection: EvidenceProtectionPort;
      admission: EvidenceWriteAdmission;
      maxChunkBytes?: number;
      maxSessionBytes?: number;
      maxRawEventBytes?: number;
    },
  ) {
    this.#directory = options.directory;
    this.#maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.#maxSessionBytes = options.maxSessionBytes ?? 512 * 1024;
    this.#maxRawEventBytes = options.maxRawEventBytes ?? 4 * 1024 * 1024;
  }
  async initialize(): Promise<this> {
    if (this.#state !== "new") throw new Error("evidence_store_already_initialized");
    this.#state = "initializing";
    try {
      await this.options.admission.openStream(this.options.runId);
      await ensurePrivateDirectory(this.#directory);
      if (!(await lstat(this.#directory)).isDirectory())
        throw new Error("evidence_directory_invalid");
      this.#directory = await realpath(this.#directory);
      const verified = await this.verify();
      this.#nextSequence = (verified.lastSequence ?? -1) + 1;
      this.#state = "ready";
      return this;
    } catch (error) {
      this.#state = "new";
      throw error;
    }
  }
  get nextSequence(): number {
    return this.#nextSequence + this.#pending.length;
  }
  discardPending(): void {
    if (this.#busy) throw new Error("evidence_writer_busy");
    this.#pending = [];
    this.#pendingBytes = 0;
  }
  private async mutation<R>(operation: () => Promise<R>): Promise<R> {
    if (this.#state !== "ready" || this.#busy) throw new Error("evidence_writer_busy");
    this.#busy = true;
    try {
      this.options.admission.assertActive();
      return await operation();
    } finally {
      this.#busy = false;
    }
  }
  append(payload: T): Promise<number> {
    return this.mutation(async () => {
      const bytes = Buffer.byteLength(JSON.stringify({ sequence: this.nextSequence, payload }));
      if (bytes > this.#maxRawEventBytes) throw new Error("evidence_event_exceeds_raw_capacity");
      if (this.#pendingBytes + bytes > this.#maxChunkBytes) await this.flushPending();
      const sequence = this.nextSequence;
      this.#pending.push({ sequence, payload });
      this.#pendingBytes += bytes;
      return sequence;
    });
  }
  flush(): Promise<{
    filename: string;
    digest: string;
    firstSequence: number;
    lastSequence: number;
  } | null> {
    return this.mutation(() => this.flushPending());
  }
  private async flushPending() {
    if (!this.#pending.length) return null;
    const { admission, protection } = this.options;
    const snapshot = await admission.readStream();
    const first = this.#pending[0]!,
      last = this.#pending.at(-1)!;
    if (first.sequence !== (snapshot.chunks.at(-1)?.lastSequence ?? -1) + 1)
      throw new Error("evidence_sequence_conflict");
    const plaintext = Buffer.from(JSON.stringify({ events: this.#pending }));
    const compressed = gzipSync(plaintext, { level: 6 });
    if (compressed.length > this.#maxChunkBytes)
      throw new Error("evidence_chunk_capacity_exceeded");
    if (snapshot.totalBytes + compressed.length > this.#maxSessionBytes)
      throw new Error("evidence_session_capacity_exceeded");
    const aad: EvidenceAad = {
      evidenceFormat: 1,
      compression: "gzip",
      runId: this.options.runId,
      scopeId: this.options.scopeId,
      streamId: snapshot.id,
      ownerGeneration: admission.ownerGeneration,
      chunk: snapshot.chunkCount,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      previousDigest: snapshot.chainHead ?? "GENESIS",
    };
    const aadBytes = Buffer.from(JSON.stringify(aad));
    const { nonce, ciphertext, tag } = protection.encrypt(compressed, aadBytes);
    const digest = evidenceDigest([aadBytes, nonce, ciphertext, tag]);
    const record: EncryptedChunk = {
      aad,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
      digest,
    };
    const bytes = Buffer.from(JSON.stringify(record));
    const objectKey = `objects/${admission.ownerGeneration}/${randomUUID()}.json`;
    for (const directory of [
      path.join(this.#directory, "objects"),
      path.join(this.#directory, "objects", String(admission.ownerGeneration)),
    ]) {
      await ensurePrivateDirectory(directory);
      if (!(await lstat(directory)).isDirectory()) throw new Error("evidence_directory_invalid");
    }
    const filename = path.join(this.#directory, objectKey);
    const handle = await open(
      filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const directory of [
      path.dirname(filename),
      path.dirname(path.dirname(filename)),
      this.#directory,
    ]) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    admission.assertActive();
    const receipt: EvidenceChunkReceipt = {
      streamId: snapshot.id,
      ownerGeneration: admission.ownerGeneration,
      chunkIndex: snapshot.chunkCount,
      objectKey,
      objectDigest: evidenceDigest([bytes]),
      objectBytes: bytes.length,
      digest,
      previousDigest: aad.previousDigest,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      plaintextBytes: plaintext.length,
      storedBytes: compressed.length,
    };
    await admission.admitChunk(receipt);
    admission.assertActive();
    this.#nextSequence = last.sequence + 1;
    this.#pending = [];
    this.#pendingBytes = 0;
    return {
      filename: objectKey,
      digest,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
    };
  }
  verify(): Promise<EvidenceVerification<T>> {
    return new AdmittedEvidenceReader<T>({ ...this.options, directory: this.#directory }).verify();
  }
}
