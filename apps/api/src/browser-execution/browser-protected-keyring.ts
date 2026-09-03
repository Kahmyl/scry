import { hkdfSync } from "node:crypto";

const DEFAULT_KEY_VERSION = "browser-v2-key-1";
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/u;

export class BrowserProtectedKeyring {
  readonly #activeVersion: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  private constructor(activeVersion: string, keys: ReadonlyMap<string, Buffer>) {
    this.#activeVersion = activeVersion;
    this.#keys = keys;
  }

  static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): BrowserProtectedKeyring {
    const activeVersion = environment.BROWSER_V2_PROTECTED_KEY_VERSION ?? DEFAULT_KEY_VERSION;
    if (!VERSION_PATTERN.test(activeVersion))
      throw new Error("BROWSER_V2_PROTECTED_KEY_VERSION_INVALID");

    const serializedKeyring = environment.BROWSER_V2_PROTECTED_KEYS_JSON;
    if (serializedKeyring) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(serializedKeyring);
      } catch {
        throw new Error("BROWSER_V2_PROTECTED_KEYS_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("BROWSER_V2_PROTECTED_KEYS_INVALID");
      const keys = new Map<string, Buffer>();
      for (const [version, encoded] of Object.entries(parsed)) {
        if (!VERSION_PATTERN.test(version) || typeof encoded !== "string")
          throw new Error("BROWSER_V2_PROTECTED_KEYS_INVALID");
        keys.set(version, decodeKey(encoded, "BROWSER_V2_PROTECTED_KEYS_INVALID"));
      }
      if (keys.size === 0) throw new Error("BROWSER_V2_PROTECTED_KEYS_INVALID");
      if (!keys.has(activeVersion)) throw new Error("BROWSER_V2_ACTIVE_KEY_UNAVAILABLE");
      return new BrowserProtectedKeyring(activeVersion, keys);
    }

    const encoded = environment.BROWSER_V2_PROTECTED_KEY_BASE64;
    if (!encoded) throw new Error("BROWSER_V2_PROTECTED_KEY_REQUIRED");
    return new BrowserProtectedKeyring(
      activeVersion,
      new Map([[activeVersion, decodeKey(encoded, "BROWSER_V2_PROTECTED_KEY_INVALID")]]),
    );
  }

  get activeVersion(): string {
    return this.#activeVersion;
  }

  key(version: string): Buffer {
    const key = this.#keys.get(version);
    if (!key) throw new Error("BROWSER_V2_PROTECTED_KEY_VERSION_UNAVAILABLE");
    return Buffer.from(key);
  }

  derive(version: string, purpose: string, context: string): Buffer {
    if (!VERSION_PATTERN.test(purpose) || context.length === 0)
      throw new Error("BROWSER_V2_KEY_DERIVATION_CONTEXT_INVALID");
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.key(version),
        Buffer.from(context, "utf8"),
        Buffer.from(`scry/browser-v2/${purpose}/v1`, "utf8"),
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
