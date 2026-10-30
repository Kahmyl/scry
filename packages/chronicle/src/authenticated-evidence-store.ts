import { createHash } from "node:crypto";
import { open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { EvidenceProtectionPort, EvidenceWriteAdmission } from "@scry/contracts";
import { durableWrite, ensurePrivateDirectory, isNodeError } from "./durable-file.js";

interface EvidenceEnvelope<T> {
  sequence: number;
  payload: T;
}

interface EvidenceAad {
  evidenceFormat?: 1;
  evidenceVersion?: 1;
  compression: "gzip";
  runId: string;
  scopeId: string;
  chunk: number;
  firstSequence: number;
  lastSequence: number;
  previousDigest: string;
}

interface EncryptedChunk {
  aad: EvidenceAad;
  nonce: string;
  ciphertext: string;
  tag: string;
  digest: string;
}

interface ManifestEntry extends EvidenceAad {
  filename: string;
  digest: string;
  plaintextBytes: number;
  storedBytes: number;
}

export interface EvidenceVerification<T> {
  events: T[];
  chunks: number;
  complete: boolean;
  gaps: Array<{ type: "partial_chunk"; name: string }>;
  lastDigest: string | null;
  lastSequence: number | null;
  plaintextBytes: number;
  storedBytes: number;
}

function digest(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function chunkFilename(index: number): string {
  return `chunk-${String(index).padStart(6, "0")}.json`;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AuthenticatedEvidenceStore<T> {
  readonly #directory: string;
  readonly #runId: string;
  readonly #scopeId: string;
  readonly #maxChunkBytes: number;
  readonly #maxSessionBytes: number;
  readonly #maxRawEventBytes: number;
  #pending: Array<EvidenceEnvelope<T>> = [];
  #pendingBytes = 0;
  #totalBytes = 0;
  #nextChunk = 0;
  #nextSequence = 0;
  #previousDigest = "GENESIS";
  readonly #cipher: EvidenceProtectionPort;
  readonly #admission: EvidenceWriteAdmission;

  constructor(options: {
    directory: string;
    runId: string;
    scopeId: string;
    protection: EvidenceProtectionPort;
    admission: EvidenceWriteAdmission;
    maxChunkBytes?: number;
    maxSessionBytes?: number;
    maxRawEventBytes?: number;
  }) {
    this.#directory = options.directory;
    this.#runId = options.runId;
    this.#scopeId = options.scopeId;
    this.#cipher = options.protection;
    this.#admission = options.admission;
    this.#maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.#maxSessionBytes = options.maxSessionBytes ?? 512 * 1024;
    this.#maxRawEventBytes = options.maxRawEventBytes ?? 4 * 1024 * 1024;
  }

  async initialize(): Promise<this> {
    const durable = await this.#admission.run(async () => {
      await ensurePrivateDirectory(this.#directory);
      return this.#withWriteLock(async () => {
        await this.#reconcileAuthenticatedOrphans();
        return this.verify();
      });
    });
    this.#nextChunk = durable.chunks;
    this.#previousDigest = durable.lastDigest ?? "GENESIS";
    this.#totalBytes = durable.storedBytes;
    this.#nextSequence = durable.lastSequence === null ? 0 : durable.lastSequence + 1;
    return this;
  }

  get nextSequence(): number {
    return this.#nextSequence + this.#pending.length;
  }

  /** Recording's owner must stop receipt and join all append/flush work first.
   * Drop only non-durable pending references; do not publish, rewind durable
   * sequence/custody, or rewrite historical chunks and manifests. */
  discardPending(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  async append(payload: T): Promise<number> {
    const envelope: EvidenceEnvelope<T> = {
      sequence: this.#nextSequence + this.#pending.length,
      payload,
    };
    const encoded = Buffer.from(JSON.stringify(envelope));
    if (encoded.length > this.#maxRawEventBytes)
      throw new Error("evidence_event_exceeds_raw_capacity");
    if (this.#pendingBytes + encoded.length > this.#maxChunkBytes) await this.flush();
    this.#pending.push(envelope);
    this.#pendingBytes += encoded.length;
    return envelope.sequence;
  }

  async flush(): Promise<{
    filename: string;
    digest: string;
    firstSequence: number;
    lastSequence: number;
  } | null> {
    if (this.#pending.length === 0) return null;
    return this.#admission.run(() =>
      this.#withWriteLock(async () => {
        await this.#reconcileAuthenticatedOrphans();
        const durable = await this.verify();
        this.#nextChunk = durable.chunks;
        this.#previousDigest = durable.lastDigest ?? "GENESIS";
        this.#totalBytes = durable.storedBytes;
        const expectedSequence = durable.lastSequence === null ? 0 : durable.lastSequence + 1;
        const first = this.#pending[0];
        const last = this.#pending.at(-1);
        if (!first || !last || first.sequence !== expectedSequence)
          throw new Error("evidence_sequence_conflict");
        const plaintext = Buffer.from(JSON.stringify({ events: this.#pending }));
        const compressed = gzipSync(plaintext, { level: 6 });
        if (compressed.length > this.#maxChunkBytes)
          throw new Error("evidence_chunk_capacity_exceeded");
        if (this.#totalBytes + compressed.length > this.#maxSessionBytes)
          throw new Error("evidence_session_capacity_exceeded");
        const aad: EvidenceAad = {
          evidenceFormat: 1,
          compression: "gzip",
          runId: this.#runId,
          scopeId: this.#scopeId,
          chunk: this.#nextChunk,
          firstSequence: first.sequence,
          lastSequence: last.sequence,
          previousDigest: this.#previousDigest,
        };
        const aadBytes = Buffer.from(JSON.stringify(aad));
        const { nonce, ciphertext, tag } = this.#cipher.encrypt(compressed, aadBytes);
        const chunkDigest = digest([aadBytes, nonce, ciphertext, tag]);
        const record: EncryptedChunk = {
          aad,
          nonce: nonce.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          tag: tag.toString("base64"),
          digest: chunkDigest,
        };
        const filename = chunkFilename(this.#nextChunk);
        await durableWrite(path.join(this.#directory, filename), JSON.stringify(record));
        await this.#appendManifest({
          filename,
          ...aad,
          digest: chunkDigest,
          plaintextBytes: plaintext.length,
          storedBytes: compressed.length,
        });
        this.#totalBytes += compressed.length;
        this.#nextSequence = last.sequence + 1;
        this.#previousDigest = chunkDigest;
        this.#nextChunk += 1;
        this.#pending = [];
        this.#pendingBytes = 0;
        return {
          filename,
          digest: chunkDigest,
          firstSequence: first.sequence,
          lastSequence: last.sequence,
        };
      }),
    );
  }

  async verify(): Promise<EvidenceVerification<T>> {
    const names = await readdir(this.#directory);
    const files = names.filter((name) => /^chunk-\d{6}\.json$/u.test(name)).sort();
    const manifest = await this.#readManifest();
    if (
      !sameArray(
        files,
        manifest.map((entry) => entry.filename),
      )
    )
      throw new Error("evidence_manifest_chunk_set_mismatch");
    const events: T[] = [];
    let expectedPrevious = "GENESIS";
    let expectedSequence = 0;
    let plaintextBytes = 0;
    let storedBytes = 0;
    for (let index = 0; index < files.length; index += 1) {
      const filename = files[index];
      const entry = manifest[index];
      if (!filename || !entry) throw new Error("evidence_manifest_invalid");
      const decoded = await this.#decodeRecord(filename, index, expectedPrevious);
      if (
        entry.digest !== decoded.record.digest ||
        entry.firstSequence !== decoded.record.aad.firstSequence ||
        entry.lastSequence !== decoded.record.aad.lastSequence ||
        entry.plaintextBytes !== decoded.plaintextBytes ||
        entry.storedBytes !== decoded.storedBytes
      )
        throw new Error("evidence_manifest_entry_mismatch");
      for (const event of decoded.events) {
        if (event.sequence !== expectedSequence) throw new Error("evidence_sequence_gap");
        expectedSequence += 1;
        events.push(event.payload);
      }
      expectedPrevious = decoded.record.digest;
      plaintextBytes += decoded.plaintextBytes;
      storedBytes += decoded.storedBytes;
    }
    const partials = names.filter((name) => name.includes(".partial-"));
    return {
      events,
      chunks: files.length,
      complete: partials.length === 0,
      gaps: partials.map((name) => ({ type: "partial_chunk", name })),
      lastDigest: expectedPrevious === "GENESIS" ? null : expectedPrevious,
      lastSequence: expectedSequence === 0 ? null : expectedSequence - 1,
      plaintextBytes,
      storedBytes,
    };
  }

  async bytesOnDisk(): Promise<number> {
    let total = 0;
    for (const name of await readdir(this.#directory))
      total += (await stat(path.join(this.#directory, name))).size;
    return total;
  }

  async #readManifest(): Promise<ManifestEntry[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.#directory, "manifest.jsonl"), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const entries = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ManifestEntry);
      entries.forEach((entry, index) => {
        if (
          entry.filename !== chunkFilename(index) ||
          entry.chunk !== index ||
          entry.runId !== this.#runId ||
          entry.scopeId !== this.#scopeId
        )
          throw new Error("evidence_manifest_invalid");
      });
      return entries;
    } catch {
      throw new Error("evidence_manifest_invalid");
    }
  }

  async #appendManifest(entry: ManifestEntry): Promise<void> {
    const handle = await open(path.join(this.#directory, "manifest.jsonl"), "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #decodeRecord(
    filename: string,
    expectedChunk: number,
    expectedPrevious: string,
  ): Promise<{
    record: EncryptedChunk;
    events: Array<EvidenceEnvelope<T>>;
    plaintextBytes: number;
    storedBytes: number;
  }> {
    let record: EncryptedChunk;
    try {
      record = JSON.parse(
        await readFile(path.join(this.#directory, filename), "utf8"),
      ) as EncryptedChunk;
    } catch {
      throw new Error("evidence_chunk_record_invalid");
    }
    if (
      (record.aad.evidenceFormat !== 1 && record.aad.evidenceVersion !== 1) ||
      record.aad.runId !== this.#runId ||
      record.aad.scopeId !== this.#scopeId ||
      record.aad.chunk !== expectedChunk ||
      record.aad.previousDigest !== expectedPrevious
    )
      throw new Error("evidence_chunk_chain_invalid");
    const aad = Buffer.from(JSON.stringify(record.aad));
    const nonce = Buffer.from(record.nonce, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (
      nonce.length !== 12 ||
      tag.length !== 16 ||
      digest([aad, nonce, ciphertext, tag]) !== record.digest
    ) {
      throw new Error("evidence_chunk_digest_invalid");
    }
    const plaintext = this.#cipher.decryptCompressed(aad, nonce, ciphertext, tag);
    let events: Array<EvidenceEnvelope<T>>;
    try {
      const parsed = JSON.parse(plaintext.toString("utf8")) as {
        events?: Array<EvidenceEnvelope<T>>;
      };
      if (!Array.isArray(parsed.events) || parsed.events.length === 0) throw new Error("invalid");
      events = parsed.events;
    } catch {
      throw new Error("evidence_chunk_plaintext_invalid");
    }
    if (
      events[0]?.sequence !== record.aad.firstSequence ||
      events.at(-1)?.sequence !== record.aad.lastSequence
    )
      throw new Error("evidence_chunk_sequence_metadata_invalid");
    return {
      record,
      events,
      plaintextBytes: plaintext.length,
      storedBytes: gunzipSafeStoredBytes(record),
    };
  }

  async #reconcileAuthenticatedOrphans(): Promise<void> {
    const files = (await readdir(this.#directory))
      .filter((name) => /^chunk-\d{6}\.json$/u.test(name))
      .sort();
    const manifest = await this.#readManifest();
    if (
      manifest.length > files.length ||
      !sameArray(
        files.slice(0, manifest.length),
        manifest.map((entry) => entry.filename),
      )
    ) {
      throw new Error("evidence_manifest_chunk_set_mismatch");
    }
    let previousDigest = manifest.at(-1)?.digest ?? "GENESIS";
    for (let index = manifest.length; index < files.length; index += 1) {
      const filename = files[index];
      if (!filename || filename !== chunkFilename(index))
        throw new Error("evidence_manifest_chunk_set_mismatch");
      const decoded = await this.#decodeRecord(filename, index, previousDigest);
      await this.#appendManifest({
        filename,
        ...decoded.record.aad,
        digest: decoded.record.digest,
        plaintextBytes: decoded.plaintextBytes,
        storedBytes: decoded.storedBytes,
      });
      previousDigest = decoded.record.digest;
    }
  }

  async #withWriteLock<R>(operation: () => Promise<R>): Promise<R> {
    const lockPath = path.join(this.#directory, ".evidence-write.lock");
    const deadline = Date.now() + 5_000;
    let handle: Awaited<ReturnType<typeof open>>;
    while (true) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
        await handle.sync();
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
            pid?: unknown;
            acquiredAt?: unknown;
          };
          let alive = true;
          try {
            process.kill(Number(owner.pid), 0);
          } catch {
            alive = false;
          }
          stale =
            !alive ||
            typeof owner.acquiredAt !== "number" ||
            Date.now() - owner.acquiredAt > 30_000;
        } catch {
          stale = true;
        }
        if (stale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error("evidence_write_lock_timeout");
        await wait(5);
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function gunzipSafeStoredBytes(record: EncryptedChunk): number {
  return Buffer.from(record.ciphertext, "base64").length;
}
