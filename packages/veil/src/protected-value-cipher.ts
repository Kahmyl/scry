import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BrowserProtectedKeyring } from "./protected-keyring.js";

export interface EncryptedProtectedValue {
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  valueDigest: string;
  keyId: string;
}

export class BrowserProtectedValueCipher {
  activeKeyId(): string {
    return BrowserProtectedKeyring.fromEnvironment().activeKeyId;
  }

  encrypt(value: string, context: Record<string, string>): EncryptedProtectedValue {
    const keyring = BrowserProtectedKeyring.fromEnvironment();
    const keyId = keyring.activeKeyId;
    const plaintext = Buffer.from(value, "utf8");
    const nonce = randomBytes(12);
    const aad = Buffer.from(JSON.stringify({ version: 1, ...context }), "utf8");
    const cipher = createCipheriv("aes-256-gcm", keyring.key(keyId), nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext,
      nonce,
      authenticationTag: cipher.getAuthTag(),
      valueDigest: createHash("sha256").update(plaintext).digest("hex"),
      keyId,
    };
  }

  decrypt(record: EncryptedProtectedValue, context: Record<string, string>): string {
    const keyring = BrowserProtectedKeyring.fromEnvironment();
    const aad = Buffer.from(JSON.stringify({ version: 1, ...context }), "utf8");
    const decipher = createDecipheriv("aes-256-gcm", keyring.key(record.keyId), record.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(record.authenticationTag);
    const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    if (createHash("sha256").update(plaintext).digest("hex") !== record.valueDigest)
      throw new Error("SCRY_BROWSER_PROTECTED_VALUE_DIGEST_MISMATCH");
    return plaintext.toString("utf8");
  }
}
