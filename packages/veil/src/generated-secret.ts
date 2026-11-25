import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import {
  sealedNativeSecretSchema,
  captureGeneratedSecretSchema,
  type NativeSecretCaptureRequest,
  type NativeSecretCaptureAdmission,
  type CaptureGeneratedSecret,
  type PraxisSessionScope,
} from "@scry/contracts";
import { BrowserProtectedValueCipher } from "./protected-value-cipher.js";
import { SensitiveValueClassifier } from "./classifier.js";
const fail = () => new Error("SCRY_BROWSER_GENERATED_SECRET_CAPTURE_UNAVAILABLE");
const publicBytes = (key: ReturnType<typeof createPublicKey>) =>
  key.export({ format: "der", type: "spki" }).toString("base64");
const keyFor = (privateKey: KeyObject, publicKey: string, context: string) => {
  const remote = createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (remote.asymmetricKeyType !== "x25519") throw fail();
  return Buffer.from(
    hkdfSync(
      "sha256",
      diffieHellman({ privateKey, publicKey: remote }),
      Buffer.alloc(0),
      Buffer.from(context),
      32,
    ),
  );
};
/** Only a public, short-lived wrapping key crosses into the private worker. */
export function sealNativeGeneratedSecret(value: string, request: NativeSecretCaptureRequest) {
  if (
    !value ||
    Buffer.byteLength(value) > 8192 ||
    Date.now() >= request.expiresAt ||
    request.context.length > 4096
  )
    throw fail();
  let key: Buffer | undefined;
  try {
    const pair = generateKeyPairSync("x25519"),
      nonce = randomBytes(12);
    key = keyFor(pair.privateKey, request.publicKey, request.context);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(request.context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    key.fill(0);
    return {
      version: 1 as const,
      publicKey: publicBytes(pair.publicKey),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } catch {
    throw fail();
  } finally {
    key?.fill(0);
  }
}
export function createNativeSecretCapture(
  scope: PraxisSessionScope,
  input: CaptureGeneratedSecret,
  commandId: string,
  environmentId: string,
): NativeSecretCaptureAdmission {
  input = captureGeneratedSecretSchema.parse(input);
  if (
    !input.userConfirmed ||
    !(scope.allowedOrigins ?? [scope.baseOrigin]).includes(input.sourceOrigin)
  )
    throw fail();
  const pair = generateKeyPairSync("x25519"),
    id = randomUUID(),
    expiresAt = Date.now() + 30000;
  let privateKey: KeyObject | undefined = pair.privateKey;
  const publicKey = publicBytes(pair.publicKey);
  const context = JSON.stringify({
    version: 1,
    id,
    sessionId: scope.sessionId,
    ownerGeneration: scope.ownerGeneration,
    commandId,
    sourceOrigin: input.sourceOrigin,
    permittedUses: input.permittedUses,
    expiresAt,
  });
  let disposed = false,
    accepted = false;
  return {
    request: { publicKey, context, expiresAt },
    accept(value) {
      if (disposed || accepted || !privateKey || Date.now() >= expiresAt) throw fail();
      let key: Buffer | undefined, plaintext: Buffer | undefined;
      try {
        const envelope = sealedNativeSecretSchema.parse(value);
        key = keyFor(privateKey, envelope.publicKey, context);
        const nonce = Buffer.from(envelope.nonce, "base64"),
          tag = Buffer.from(envelope.tag, "base64"),
          ciphertext = Buffer.from(envelope.ciphertext, "base64");
        if (
          nonce.length !== 12 ||
          tag.length !== 16 ||
          ciphertext.length < 1 ||
          ciphertext.length > 8192
        )
          throw fail();
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const secret = plaintext.toString("utf8");
        if (!secret || !Buffer.from(secret, "utf8").equals(plaintext)) throw fail();
        const displayName = new SensitiveValueClassifier({
          protectedValues: { generated: secret },
        }).sanitize(input.displayName);
        const encrypted = new BrowserProtectedValueCipher().encrypt(secret, {
          projectId: scope.projectId,
          protectedValueId: id,
          canonicalName: displayName,
          sourceKind: "browser_generated",
        });
        plaintext.fill(0);
        accepted = true;
        return {
          metadata: {
            protectedValueId: id,
            displayName,
            state: "active",
            sourceOrigin: input.sourceOrigin,
            sourceRunId: scope.runId,
            sourceCommandId: commandId,
            environmentId,
            sourceOwnerGeneration: scope.ownerGeneration,
            permittedUses: [...input.permittedUses],
            expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
          },
          encrypted,
        };
      } catch {
        throw fail();
      } finally {
        key?.fill(0);
        plaintext?.fill(0);
      }
    },
    dispose() {
      disposed = true;
      privateKey = undefined;
    },
  };
}
export function verifyRawWebhookHmac(
  secret: string,
  body: Buffer,
  signature: string,
  encoding: "hex" | "base64",
  prefix = "",
  timestamp?: string,
) {
  if (
    body.length > 512 * 1024 ||
    signature.length > 256 ||
    !signature.startsWith(prefix) ||
    (timestamp !== undefined && !/^[^\r\n\0]{1,256}$/.test(timestamp))
  )
    return false;
  const supplied = signature.slice(prefix.length);
  if (
    encoding === "hex" ? !/^[a-f0-9]{64}$/i.test(supplied) : !/^[A-Za-z0-9+/]{43}=$/.test(supplied)
  )
    return false;
  const hmac = createHmac("sha256", secret);
  if (timestamp !== undefined) hmac.update(timestamp + ".");
  const expected = hmac.update(body).digest(),
    actual = Buffer.from(supplied, encoding);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
