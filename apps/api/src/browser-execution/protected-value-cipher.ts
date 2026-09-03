import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { BrowserProtectedKeyring } from "./browser-protected-keyring.js";

export interface EncryptedProtectedValue {
  ciphertext: Buffer;
  nonce: Buffer;
  authenticationTag: Buffer;
  valueDigest: string;
  keyVersion: string;
}

@Injectable()
export class BrowserProtectedValueCipher {
  activeKeyVersion(): string {
    return BrowserProtectedKeyring.fromEnvironment().activeVersion;
  }

  encrypt(value: string, context: Record<string, string>): EncryptedProtectedValue {
    const keyring = BrowserProtectedKeyring.fromEnvironment();
    const keyVersion = keyring.activeVersion;
    const plaintext = Buffer.from(value, "utf8");
    const nonce = randomBytes(12);
    const aad = Buffer.from(JSON.stringify({ version: 1, ...context }), "utf8");
    const cipher = createCipheriv("aes-256-gcm", keyring.key(keyVersion), nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext,
      nonce,
      authenticationTag: cipher.getAuthTag(),
      valueDigest: createHash("sha256").update(plaintext).digest("hex"),
      keyVersion,
    };
  }

  decrypt(record: EncryptedProtectedValue, context: Record<string, string>): string {
    const keyring = BrowserProtectedKeyring.fromEnvironment();
    const aad = Buffer.from(JSON.stringify({ version: 1, ...context }), "utf8");
    const decipher = createDecipheriv("aes-256-gcm", keyring.key(record.keyVersion), record.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(record.authenticationTag);
    const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]);
    if (createHash("sha256").update(plaintext).digest("hex") !== record.valueDigest)
      throw new Error("BROWSER_V2_PROTECTED_VALUE_DIGEST_MISMATCH");
    return plaintext.toString("utf8");
  }
}
