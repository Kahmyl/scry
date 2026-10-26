import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VeilBrowserProtection } from "../src/browser-protection.js";
import { BrowserProtectedKeyring } from "../src/protected-keyring.js";
import { EvidenceCipher } from "../src/evidence-cipher.js";

beforeEach(() => {
  vi.stubEnv("SCRY_BROWSER_PROTECTED_KEYS_JSON", "");
  vi.stubEnv("BROWSER_V2_PROTECTED_KEYS_JSON", "");
  vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", randomBytes(32).toString("base64"));
  vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_ID", "fixture-evidence-key");
});
afterEach(() => vi.unstubAllEnvs());
function fixture(historical = false) {
  const scope = {
    runId: "fixture-run",
    sessionId: "fixture-session",
    protectionKeyId: "fixture-evidence-key",
  };
  const keyring = BrowserProtectedKeyring.fromEnvironment();
  const context = `${scope.runId}:${scope.sessionId}`;
  const key = historical
    ? keyring.deriveLegacy(scope.protectionKeyId, "evidence", context)
    : keyring.derive(scope.protectionKeyId, "evidence", context);
  const aad = Buffer.from("fictional receipt scope"),
    value = Buffer.from("fictional protected event");
  const encrypted = new EvidenceCipher(key).encrypt(gzipSync(value), aad);
  return { scope, aad, value, encrypted };
}
describe("decrypt-only stopped-evidence capability", () => {
  it.each([false, true])(
    "reads the exact evidence context with historical compatibility=%s without granting encryption or capture",
    (historical) => {
      const f = fixture(historical);
      const reader = new VeilBrowserProtection().readEvidence(f.scope);
      expect(Object.keys(reader)).toEqual(["decryptCompressed"]);
      expect(
        reader.decryptCompressed(f.aad, f.encrypted.nonce, f.encrypted.ciphertext, f.encrypted.tag),
      ).toEqual(f.value);
      expect(reader).not.toHaveProperty("encrypt");
      expect(reader).not.toHaveProperty("vault");
    },
  );
  it("binds the read capability to immutable identity rather than later caller mutation", () => {
    const f = fixture();
    const reader = new VeilBrowserProtection().readEvidence(f.scope);
    f.scope.sessionId = "different-session";
    expect(
      reader.decryptCompressed(f.aad, f.encrypted.nonce, f.encrypted.ciphertext, f.encrypted.tag),
    ).toEqual(f.value);
  });
  it("can construct a read-only closure before key acquisition but never decrypts without the required key", () => {
    const f = fixture();
    vi.stubEnv("SCRY_BROWSER_PROTECTED_KEY_BASE64", "");
    vi.stubEnv("BROWSER_V2_PROTECTED_KEY_BASE64", "");
    const reader = new VeilBrowserProtection().readEvidence(f.scope);
    expect(() =>
      reader.decryptCompressed(f.aad, f.encrypted.nonce, f.encrypted.ciphertext, f.encrypted.tag),
    ).toThrow("PROTECTED_KEY_REQUIRED");
  });
});
