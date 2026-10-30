import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** Protects evidence bytes; ordering, manifests, and storage belong to the evidence owner. */
export class EvidenceCipher {
  readonly #key: Buffer;
  readonly #historicalKeys: readonly Buffer[];

  constructor(key: Buffer, historicalKeys: readonly Buffer[] = []) {
    if (key.length !== 32 || historicalKeys.some((candidate) => candidate.length !== 32))
      throw new Error("evidence_key_invalid");
    this.#key = Buffer.from(key);
    this.#historicalKeys = historicalKeys.map((candidate) => Buffer.from(candidate));
  }

  encrypt(compressed: Buffer, aad: Buffer) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag() };
  }

  decryptCompressed(aad: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
    for (const key of [this.#key, ...this.#historicalKeys]) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      } catch {
        // Historical keys are read-only compatibility candidates.
      }
    }
    throw new Error("evidence_chunk_authentication_invalid");
  }
}
