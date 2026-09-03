import { open, readFile } from "node:fs/promises";

import { canonicalJson, sha256 } from "./internal.js";
import type { EngineeringLabLedgerEntry, EngineeringLabLedgerEntryInput } from "./types.js";

export class EngineeringLabLedger {
  readonly #path: string;
  #lastHash: string | null = null;
  #sequence = 0;

  private constructor(path: string) {
    this.#path = path;
  }

  static async create(path: string): Promise<EngineeringLabLedger> {
    const handle = await open(path, "wx", 0o600);
    await handle.close();

    return new EngineeringLabLedger(path);
  }

  get path(): string {
    return this.#path;
  }

  async append(input: EngineeringLabLedgerEntryInput): Promise<EngineeringLabLedgerEntry> {
    const withoutHash = {
      ...input,
      sequence: this.#sequence + 1,
      timestamp: input.timestamp ?? new Date().toISOString(),
      previousHash: this.#lastHash,
    };
    const entry: EngineeringLabLedgerEntry = {
      ...withoutHash,
      hash: sha256(canonicalJson(withoutHash)),
    };
    const handle = await open(this.#path, "a", 0o600);

    try {
      await handle.write(`${canonicalJson(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.#sequence = entry.sequence;
    this.#lastHash = entry.hash;

    return entry;
  }
}

export async function verifyEngineeringLabLedger(path: string): Promise<{
  valid: boolean;
  entries: readonly EngineeringLabLedgerEntry[];
  error?: string;
}> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter(Boolean);
  const entries: EngineeringLabLedgerEntry[] = [];
  let previousHash: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    let entry: EngineeringLabLedgerEntry;

    try {
      entry = JSON.parse(line) as EngineeringLabLedgerEntry;
    } catch {
      return {
        valid: false,
        entries,
        error: `invalid_json:${index + 1}`,
      };
    }

    const { hash, ...withoutHash } = entry;
    const expectedHash = sha256(canonicalJson(withoutHash));

    if (entry.sequence !== index + 1) {
      return { valid: false, entries, error: `sequence:${index + 1}` };
    }

    if (entry.previousHash !== previousHash) {
      return { valid: false, entries, error: `previous_hash:${index + 1}` };
    }

    if (hash !== expectedHash) {
      return { valid: false, entries, error: `hash:${index + 1}` };
    }

    entries.push(entry);
    previousHash = hash;
  }

  return { valid: true, entries };
}
