import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";

function encryptionKey() {
  const configured = process.env.SCRY_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("SCRY_CREDENTIAL_ENCRYPTION_KEY is required in production");
  }
  return createHash("sha256")
    .update(configured ?? "scry-local-development-credential-key")
    .digest();
}

export function encryptCredential(value: string) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(), initializationVector);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext,
    initializationVector,
    authenticationTag: cipher.getAuthTag(),
  };
}

export function decryptCredential(input: {
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
}) {
  const decipher = createDecipheriv(algorithm, encryptionKey(), input.initializationVector);
  decipher.setAuthTag(input.authenticationTag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
}
