import { describe, expect, it } from "vitest";
import { VeilBrowserProtection } from "../src/browser-protection.js";

describe("Veil-owned native diagnostic protection", () => {
  it.each([
    ["MÜnchen-472819", "MÜnchen-472819"],
    ["München", "München"],
    ["MÜnchen-472819", encodeURIComponent("MÜnchen-472819")],
    ["Ｓｅｃｒｅｔ", "Ｓｅｃｒｅｔ"],
    ["Mu\u0308nchen-472819", "Mu\u0308nchen-472819"],
    ["OpaqueΣ", "OpaqueΣ"],
    ["\u0308Opaque472819", "\u0308Opaque472819", "prefixu"],
    ["\u0301AbCd472819", encodeURIComponent("\u0301AbCd472819"), "prefixe"],
    ["\u0300Opaque472819", "\u0300Opaque472819", "prefixu\u0315"],
    ["Opaque472819u\u0315", "Opaque472819u\u0315", "prefix-", "\u0300-suffix"],
    ["\u1161Opaque472819", "\u1161Opaque472819", "prefix\u1100"],
    ["\u0300\u0315", "\u0300\u0315", "prefixu\u031a"],
  ])(
    "protects known secrets embedded within a canonical IDNA label %s",
    (secret, source, prefix = "prefix-", suffix = "-suffix") => {
      const veil = new VeilBrowserProtection().nativeDiagnostics({ login: secret });
      const hostname = new URL(`https://${prefix}${source}${suffix}.example`).hostname;
      for (const display of [`https://${hostname}`, `${hostname}:443`])
        expect(veil.sanitize(display)).not.toBe(display);
      for (const display of ["https://public.example", "public.example:443"])
        expect(veil.sanitize(display)).toBe(display);
    },
  );
  it.each(["MiXeD-Login-472819", "MÜnchen-472819", "Percent%41Secret-472819"])(
    "protects hostname canonicalization of a known secret %s",
    (secret) => {
      const veil = new VeilBrowserProtection().nativeDiagnostics({ login: secret });
      const hostname = new URL(`https://${secret}.example`).hostname;
      for (const display of [`https://${hostname}`, `${hostname}:443`]) {
        expect(veil.sanitize(display)).not.toBe(display);
        expect(String(veil.sanitize(display))).toContain("[PROTECTED:");
      }
      const encodedHost = Buffer.from(secret).toString("base64url").toLowerCase();
      expect(veil.sanitize(`https://${encodedHost}.example`)).not.toBe(
        `https://${encodedHost}.example`,
      );
    },
  );
  it("shares existing literal, encoded, base64 and built-in classifier protection", () => {
    const secret = "Sensitive-Value-472819";
    const veil = new VeilBrowserProtection().nativeDiagnostics({ login: secret });
    for (const value of [
      secret,
      secret.toLowerCase(),
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      "sk_abcdefghijklmnopqrstuv",
    ])
      expect(veil.sanitize(`https://${value}.example`)).not.toBe(`https://${value}.example`);
    expect(veil.sanitize("https://public.example")).toBe("https://public.example");
  });
  it("does not require keyring, browser, database, evidence or disclosure authority", () => {
    const veil = new VeilBrowserProtection().nativeDiagnostics({
      credential: "MiXeD-Credential-472819",
    });
    expect(veil.sanitize("mixed-credential-472819.example:443")).not.toBe(
      "mixed-credential-472819.example:443",
    );
    expect(Object.keys(veil)).toEqual(["sanitize"]);
  });
});
