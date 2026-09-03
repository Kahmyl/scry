import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserProtectedKeyring } from "../src/browser-execution/browser-protected-keyring.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";

const saved = {
  single: process.env.BROWSER_V2_PROTECTED_KEY_BASE64,
  serialized: process.env.BROWSER_V2_PROTECTED_KEYS_JSON,
  active: process.env.BROWSER_V2_PROTECTED_KEY_VERSION,
};

afterEach(() => {
  restore("BROWSER_V2_PROTECTED_KEY_BASE64", saved.single);
  restore("BROWSER_V2_PROTECTED_KEYS_JSON", saved.serialized);
  restore("BROWSER_V2_PROTECTED_KEY_VERSION", saved.active);
});

describe.sequential("browser protected keyring", () => {
  it("decrypts old records after active-key rotation and refuses a retired key", () => {
    const versions = {
      "qualification-v1": randomBytes(32).toString("base64"),
      "qualification-v2": randomBytes(32).toString("base64"),
    };
    delete process.env.BROWSER_V2_PROTECTED_KEY_BASE64;
    process.env.BROWSER_V2_PROTECTED_KEYS_JSON = JSON.stringify(versions);
    process.env.BROWSER_V2_PROTECTED_KEY_VERSION = "qualification-v1";
    const cipher = new BrowserProtectedValueCipher();
    const context = { projectId: "fixture-project", canonicalName: "credential" };
    const oldRecord = cipher.encrypt("old-protected-value", context);
    expect(oldRecord.keyVersion).toBe("qualification-v1");

    process.env.BROWSER_V2_PROTECTED_KEY_VERSION = "qualification-v2";
    expect(cipher.decrypt(oldRecord, context)).toBe("old-protected-value");
    expect(cipher.encrypt("new-protected-value", context).keyVersion).toBe("qualification-v2");

    process.env.BROWSER_V2_PROTECTED_KEYS_JSON = JSON.stringify({
      "qualification-v2": versions["qualification-v2"],
    });
    expect(() => cipher.decrypt(oldRecord, context)).toThrow(
      "BROWSER_V2_PROTECTED_KEY_VERSION_UNAVAILABLE",
    );
  });

  it("derives stable, purpose-separated session keys without exposing the master key", () => {
    const keyring = BrowserProtectedKeyring.fromEnvironment({
      BROWSER_V2_PROTECTED_KEY_BASE64: randomBytes(32).toString("base64"),
      BROWSER_V2_PROTECTED_KEY_VERSION: "qualification-v1",
    });
    const first = keyring.derive("qualification-v1", "evidence", "run:session");
    expect(first).toEqual(keyring.derive("qualification-v1", "evidence", "run:session"));
    expect(first).not.toEqual(keyring.derive("qualification-v1", "capture", "run:session"));
    expect(first).not.toEqual(keyring.derive("qualification-v1", "evidence", "run:other"));
  });

  it("rejects malformed, unavailable, and non-32-byte keys without echoing key material", () => {
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        BROWSER_V2_PROTECTED_KEYS_JSON: "{bad",
        BROWSER_V2_PROTECTED_KEY_VERSION: "v1",
      }),
    ).toThrow("BROWSER_V2_PROTECTED_KEYS_INVALID");
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        BROWSER_V2_PROTECTED_KEYS_JSON: JSON.stringify({ v1: "bm90LTMyLWJ5dGVz" }),
        BROWSER_V2_PROTECTED_KEY_VERSION: "v1",
      }),
    ).toThrow("BROWSER_V2_PROTECTED_KEYS_INVALID");
    expect(() =>
      BrowserProtectedKeyring.fromEnvironment({
        BROWSER_V2_PROTECTED_KEYS_JSON: JSON.stringify({
          v1: randomBytes(32).toString("base64"),
        }),
        BROWSER_V2_PROTECTED_KEY_VERSION: "v2",
      }),
    ).toThrow("BROWSER_V2_ACTIVE_KEY_UNAVAILABLE");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
