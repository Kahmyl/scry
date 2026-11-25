import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import {
  createNativeSecretCapture,
  sealNativeGeneratedSecret,
  verifyRawWebhookHmac,
} from "../src/generated-secret.js";
import { BrowserProtectedValueCipher } from "../src/protected-value-cipher.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = {
  sessionId: id(1),
  projectId: id(2),
  missionId: id(3),
  runId: id(4),
  baseOrigin: "https://fixture.example",
  allowedOrigins: ["https://fixture.example"],
  ownerGeneration: 1,
  protectionKeyId: "browser-key-1",
  disclosureMode: "confidential" as const,
};
const input = {
  sourceOrigin: scope.baseOrigin,
  target: { selector: "code" },
  displayName: "Synthetic signing key",
  permittedUses: ["scoped_request", "hmac_verification"] as const,
  expiresInSeconds: 3600,
  trimWhitespace: false,
  userConfirmed: true as const,
};
const secret = "fictional-generated-private-679134625";
let prior: string | undefined;
beforeEach(() => {
  prior = process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
  process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
});
afterEach(() => {
  if (prior === undefined) delete process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
  else process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = prior;
});
const open = (label = input.displayName) =>
  createNativeSecretCapture(
    scope,
    { ...input, displayName: label, permittedUses: [...input.permittedUses] },
    id(5),
    id(6),
  );
describe("browser-generated opaque capture", () => {
  it("wraps in private IPC and admits only encrypted, scoped data with safe metadata", () => {
    const capture = open();
    const envelope = sealNativeGeneratedSecret(secret, capture.request);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    const admitted = capture.accept(envelope);
    expect(admitted.metadata).toMatchObject({
      sourceOrigin: scope.baseOrigin,
      sourceRunId: scope.runId,
      sourceCommandId: id(5),
      environmentId: id(6),
      state: "active",
      permittedUses: [...input.permittedUses],
    });
    expect(JSON.stringify(admitted)).not.toContain(secret);
    expect(
      new BrowserProtectedValueCipher().decrypt(admitted.encrypted, {
        projectId: scope.projectId,
        protectedValueId: admitted.metadata.protectedValueId,
        canonicalName: admitted.metadata.displayName,
        sourceKind: "browser_generated",
      }),
    ).toBe(secret);
  });
  it("rejects cross-context replay, then permits the original exact admission once", () => {
    const a = open(),
      b = open(),
      sealed = sealNativeGeneratedSecret(secret, a.request);
    expect(() => b.accept(sealed)).toThrow("SCRY_BROWSER_GENERATED_SECRET_CAPTURE_UNAVAILABLE");
    a.accept(sealed);
    expect(() => a.accept(sealed)).toThrow("SCRY_BROWSER_GENERATED_SECRET_CAPTURE_UNAVAILABLE");
  });
  it.each(["nonce", "tag", "ciphertext", "publicKey"] as const)(
    "rejects corrupted %s without exposing a raw diagnostic",
    (field) => {
      const c = open(),
        envelope = sealNativeGeneratedSecret(secret, c.request);
      expect(() => c.accept({ ...envelope, [field]: "AAAA" })).toThrow(
        /^SCRY_BROWSER_GENERATED_SECRET_CAPTURE_UNAVAILABLE$/,
      );
    },
  );
  it("rejects expired/disposed requests and plaintext masquerading as a sealed response", () => {
    const c = open();
    expect(() => sealNativeGeneratedSecret(secret, { ...c.request, expiresAt: 0 })).toThrow();
    const sealed = sealNativeGeneratedSecret(secret, c.request);
    c.dispose();
    expect(() => c.accept(sealed)).toThrow();
    expect(() => open().accept({ secret })).toThrow(
      /^SCRY_BROWSER_GENERATED_SECRET_CAPTURE_UNAVAILABLE$/,
    );
  });
  it("masks a copied claim in a display label and never changes its private bytes", () => {
    const c = open(secret),
      v = c.accept(sealNativeGeneratedSecret(secret, c.request));
    expect(v.metadata.displayName).not.toContain(secret);
    expect(
      new BrowserProtectedValueCipher().decrypt(v.encrypted, {
        projectId: scope.projectId,
        protectedValueId: v.metadata.protectedValueId,
        canonicalName: v.metadata.displayName,
        sourceKind: "browser_generated",
      }),
    ).toBe(secret);
  });
  it("refuses scope expansion and bounds the private payload", () => {
    expect(() =>
      createNativeSecretCapture(
        scope,
        {
          ...input,
          sourceOrigin: "https://elsewhere.example",
          permittedUses: [...input.permittedUses],
        },
        id(5),
        id(6),
      ),
    ).toThrow();
    expect(() => sealNativeGeneratedSecret("x".repeat(8193), open().request)).toThrow();
  });
});
describe("exact-byte HMAC receipt", () => {
  const body = Buffer.from('{ "message": "fictional", "number": 1 }\n');
  const sign = (data: Buffer | string, encoding: "hex" | "base64") =>
    createHmac("sha256", secret).update(data).digest(encoding);
  it.each(["hex", "base64"] as const)(
    "checks %s without returning the expected signature",
    (encoding) => {
      expect(verifyRawWebhookHmac(secret, body, sign(body, encoding), encoding)).toBe(true);
      expect(
        verifyRawWebhookHmac(
          secret,
          Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
          sign(body, encoding),
          encoding,
        ),
      ).toBe(false);
      expect(verifyRawWebhookHmac("different-key", body, sign(body, encoding), encoding)).toBe(
        false,
      );
    },
  );
  it("supports an explicit timestamp-dot-body recipe without claiming replay resistance", () => {
    const signed = Buffer.concat([Buffer.from("123456."), body]);
    expect(
      verifyRawWebhookHmac(
        secret,
        body,
        "sha256=" + sign(signed, "hex"),
        "hex",
        "sha256=",
        "123456",
      ),
    ).toBe(true);
    expect(
      verifyRawWebhookHmac(
        secret,
        body,
        "sha256=" + sign(signed, "hex"),
        "hex",
        "sha256=",
        "123457",
      ),
    ).toBe(false);
  });
  it.each(["", "f", "abc", "sha256=bad", "\n".repeat(10)])(
    "refuses malformed signature %j",
    (signature) => expect(verifyRawWebhookHmac(secret, body, signature, "hex")).toBe(false),
  );
});
