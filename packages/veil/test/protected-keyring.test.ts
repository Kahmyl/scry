import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserProtectedKeyring, BrowserProtectedValueCipher } from "../src/index.js";

const saved = {
  single: process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64,
  serialized: process.env.SCRY_BROWSER_PROTECTED_KEYS_JSON,
  active: process.env.SCRY_BROWSER_PROTECTED_KEY_ID,
};

afterEach(() => {
  restore("SCRY_BROWSER_PROTECTED_KEY_BASE64", saved.single);
  restore("SCRY_BROWSER_PROTECTED_KEYS_JSON", saved.serialized);
  restore("SCRY_BROWSER_PROTECTED_KEY_ID", saved.active);
});

describe.sequential("browser protected keyring", () => {
  it("authenticates the stored value and its context after relocation", () => {
    delete process.env.SCRY_BROWSER_PROTECTED_KEYS_JSON;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    const cipher = new BrowserProtectedValueCipher();
    const context = { projectId: "fixture-project", canonicalName: "credential" };
    const record = cipher.encrypt("protected-value", context);
    expect(cipher.decrypt(record, context)).toBe("protected-value");
    expect(() => cipher.decrypt(record, { ...context, projectId: "other-project" })).toThrow();
    expect(() =>
      cipher.decrypt({ ...record, ciphertext: Buffer.alloc(record.ciphertext.length) }, context),
    ).toThrow();
  });

  it("decrypts old records after active-key rotation and refuses a retired key", () => {
    const versions = {
      "qualification-v1": randomBytes(32).toString("base64"),
      "qualification-baseline": randomBytes(32).toString("base64"),
    };
    delete process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
    process.env.SCRY_BROWSER_PROTECTED_KEYS_JSON = JSON.stringify(versions);
    process.env.SCRY_BROWSER_PROTECTED_KEY_ID = "qualification-v1";
    const cipher = new BrowserProtectedValueCipher();
    const context = { projectId: "fixture-project", canonicalName: "credential" };
    const oldRecord = cipher.encrypt("old-protected-value", context);
    expect(oldRecord.keyId).toBe("qualification-v1");

    process.env.SCRY_BROWSER_PROTECTED_KEY_ID = "qualification-baseline";
    expect(cipher.decrypt(oldRecord, context)).toBe("old-protected-value");
    expect(cipher.encrypt("new-protected-value", context).keyId).toBe("qualification-baseline");

    process.env.SCRY_BROWSER_PROTECTED_KEYS_JSON = JSON.stringify({
      "qualification-baseline": versions["qualification-baseline"],
    });
    expect(() => cipher.decrypt(oldRecord, context)).toThrow(
      "SCRY_BROWSER_PROTECTED_KEY_ID_UNAVAILABLE",
    );
  });

  it("derives stable, purpose-separated session keys without exposing the master key", () => {
    const keyring = BrowserProtectedKeyring.fromEnvironment({
      SCRY_BROWSER_PROTECTED_KEY_BASE64: randomBytes(32).toString("base64"),
      SCRY_BROWSER_PROTECTED_KEY_ID: "qualification-v1",
    });
    const first = keyring.derive("qualification-v1", "evidence", "run:session");
    expect(first).toEqual(keyring.derive("qualification-v1", "evidence", "run:session"));
    expect(first).not.toEqual(keyring.derive("qualification-v1", "capture", "run:session"));
    expect(first).not.toEqual(keyring.derive("qualification-v1", "evidence", "run:other"));
  });

  it("reads historical key configuration and preserves its derivation domain", () => {
    const encoded = Buffer.alloc(32, 7).toString("base64");
    const keyring = BrowserProtectedKeyring.fromEnvironment({
      BROWSER_V2_PROTECTED_KEYS_JSON: JSON.stringify({ "historical-key": encoded }),
      BROWSER_V2_PROTECTED_KEY_VERSION: "historical-key",
    });

    expect(keyring.activeKeyId).toBe("historical-key");
    expect(keyring.deriveLegacy("historical-key", "evidence", "run:session").toString("hex")).toBe(
      "f4fab5530d630d68bf07d544180aa2743672be1098e8b30842f469c8cb4e7d06",
    );
    expect(keyring.derive("historical-key", "evidence", "run:session")).not.toEqual(
      keyring.deriveLegacy("historical-key", "evidence", "run:session"),
    );
  });

  it("rejects malformed, unavailable, and non-32-byte keys without echoing key material", () => {
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        SCRY_BROWSER_PROTECTED_KEYS_JSON: "{bad",
        SCRY_BROWSER_PROTECTED_KEY_ID: "v1",
      }),
    ).toThrow("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        SCRY_BROWSER_PROTECTED_KEYS_JSON: JSON.stringify({ v1: "bm90LTMyLWJ5dGVz" }),
        SCRY_BROWSER_PROTECTED_KEY_ID: "v1",
      }),
    ).toThrow("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        SCRY_BROWSER_PROTECTED_KEYS_JSON: JSON.stringify({
          v1: randomBytes(32).toString("base64"),
        }),
        SCRY_BROWSER_PROTECTED_KEY_ID: "baseline",
      }),
    ).toThrow("SCRY_BROWSER_ACTIVE_KEY_UNAVAILABLE");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
