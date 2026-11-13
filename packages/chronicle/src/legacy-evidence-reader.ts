import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { EvidenceProtectionPort } from "@scry/contracts";
import type { EvidenceVerification } from "./admitted-evidence-store.js";
import { decodeEvidenceChunk, type EvidenceAad } from "./evidence-codec.js";

/** Historical bytes are decoded, never reconciled, relabeled or rewritten.
 * This capability has no append, flush or write-admission methods. */
export class LegacyEvidenceReader<T> {
  constructor(
    private readonly options: {
      directory: string;
      runId: string;
      scopeId: string;
      protection: EvidenceProtectionPort;
    },
  ) {}
  async verify(): Promise<EvidenceVerification<T>> {
    const o = this.options;
    const names = await readdir(o.directory);
    const files = names.filter((name) => /^chunk-\d{6}\.json$/u.test(name)).sort();
    let manifest: Array<
      EvidenceAad & {
        filename: string;
        digest: string;
        plaintextBytes: number;
        storedBytes: number;
      }
    >;
    try {
      manifest = (await readFile(path.join(o.directory, "manifest.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("evidence_manifest_invalid");
    }
    if (files.length !== manifest.length || files.some((name, i) => name !== manifest[i]?.filename))
      throw new Error("evidence_manifest_chunk_set_mismatch");
    const events: T[] = [];
    let previousDigest = "GENESIS",
      sequence = 0,
      plaintextBytes = 0,
      storedBytes = 0;
    for (const [index, filename] of files.entries()) {
      if (filename !== `chunk-${String(index).padStart(6, "0")}.json`)
        throw new Error("evidence_chunk_chain_invalid");
      const decoded = decodeEvidenceChunk<T>(
        await readFile(path.join(o.directory, filename)),
        o.protection,
        { runId: o.runId, sessionId: o.scopeId, chunk: index, previousDigest },
      );
      const entry = manifest[index]!;
      if (
        entry.runId !== o.runId ||
        entry.scopeId !== o.scopeId ||
        entry.chunk !== index ||
        entry.previousDigest !== previousDigest ||
        entry.digest !== decoded.record.digest ||
        entry.firstSequence !== decoded.record.aad.firstSequence ||
        entry.lastSequence !== decoded.record.aad.lastSequence ||
        entry.plaintextBytes !== decoded.plaintextBytes ||
        entry.storedBytes !== decoded.storedBytes
      )
        throw new Error("evidence_manifest_entry_mismatch");
      for (const event of decoded.events) {
        if (event.sequence !== sequence++) throw new Error("evidence_sequence_gap");
        events.push(event.payload);
      }
      previousDigest = decoded.record.digest;
      plaintextBytes += decoded.plaintextBytes;
      storedBytes += decoded.storedBytes;
    }
    const partials = names.filter((name) => name.includes(".partial-"));
    return {
      events,
      eventOwnerGenerations: [],
      chunks: files.length,
      complete: !partials.length,
      gaps: partials.map((name) => ({ type: "partial_chunk", name })),
      lastDigest: files.length ? previousDigest : null,
      lastSequence: sequence ? sequence - 1 : null,
      plaintextBytes,
      storedBytes,
    };
  }
}
