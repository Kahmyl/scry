import { hkdfSync } from "node:crypto";

const DEFAULT_KEY_ID = "browser-key-1";
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/u;

export class BrowserProtectedKeyring {
  readonly #activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  private constructor(activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    this.#activeKeyId = activeKeyId;
    this.#keys = keys;
  }

  static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): BrowserProtectedKeyring {
    const activeKeyId =
      environment.SCRY_BROWSER_PROTECTED_KEY_ID ??
      environment.BROWSER_V2_PROTECTED_KEY_VERSION ??
      DEFAULT_KEY_ID;
    if (!KEY_ID_PATTERN.test(activeKeyId)) throw new Error("SCRY_BROWSER_PROTECTED_KEY_ID_INVALID");

    const serializedKeyring =
      environment.SCRY_BROWSER_PROTECTED_KEYS_JSON ?? environment.BROWSER_V2_PROTECTED_KEYS_JSON;
    if (serializedKeyring) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serializedKeyring);
      } catch {
        throw new Error("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
      const keys = new Map<string, Buffer>();
      for (const [keyId, encoded] of Object.entries(parsed)) {
        if (!KEY_ID_PATTERN.test(keyId) || typeof encoded !== "string")
          throw new Error("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
        keys.set(keyId, decodeKey(encoded, "SCRY_BROWSER_PROTECTED_KEYS_INVALID"));
      }
      if (keys.size === 0) throw new Error("SCRY_BROWSER_PROTECTED_KEYS_INVALID");
      if (!keys.has(activeKeyId)) throw new Error("SCRY_BROWSER_ACTIVE_KEY_UNAVAILABLE");
      return new BrowserProtectedKeyring(activeKeyId, keys);
    }

    const encoded =
      environment.SCRY_BROWSER_PROTECTED_KEY_BASE64 ?? environment.BROWSER_V2_PROTECTED_KEY_BASE64;
    if (!encoded) throw new Error("SCRY_BROWSER_PROTECTED_KEY_REQUIRED");
    return new BrowserProtectedKeyring(
      activeKeyId,
      new Map([[activeKeyId, decodeKey(encoded, "SCRY_BROWSER_PROTECTED_KEY_INVALID")]]),
    );
  }

  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  key(keyId: string): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) throw new Error("SCRY_BROWSER_PROTECTED_KEY_ID_UNAVAILABLE");
    return Buffer.from(key);
  }

  derive(keyId: string, purpose: string, context: string): Buffer {
    return this.#derive(keyId, purpose, context, "scry/browser");
  }

  deriveLegacy(keyId: string, purpose: string, context: string): Buffer {
    return this.#derive(keyId, purpose, context, "scry/browser-v2");
  }

  #derive(keyId: string, purpose: string, context: string, domain: string): Buffer {
    if (!KEY_ID_PATTERN.test(purpose) || context.length === 0)
      throw new Error("SCRY_BROWSER_KEY_DERIVATION_CONTEXT_INVALID");
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.key(keyId),
        Buffer.from(context, "utf8"),
        Buffer.from(`${domain}/${purpose}/v1`, "utf8"),
        32,
      ),
    );
  }
}

function decodeKey(encoded: string, errorCode: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error(errorCode);
  return key;
}
