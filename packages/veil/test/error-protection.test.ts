import { describe, expect, it } from "vitest";
import {
  storedBrowserFailureCode,
  publicBrowserErrorCode,
  finalizationBrowserErrorCode,
} from "../src/error-protection.js";

describe("value-free failure disclosure", () => {
  it.each([
    "SCRY_BROWSER_EVIDENCE_STREAM_MISSING",
    "SCRY_BROWSER_EVIDENCE_ARTIFACT_UNAVAILABLE",
    "SCRY_BROWSER_EVIDENCE_READ_ONLY",
    "SCRY_BROWSER_EVIDENCE_RECEIPT_INVALID",
    "SCRY_BROWSER_EVIDENCE_RECEIPT_CONFLICT",
    "SCRY_BROWSER_EVIDENCE_CAPTURE_CLOSED",
    "SCRY_BROWSER_EVIDENCE_STOP_UNCONFIRMED",
    "SCRY_BROWSER_EVIDENCE_STOP_CONFLICT",
    "SCRY_BROWSER_EVIDENCE_COMPLETION_INVALID",
    "SCRY_BROWSER_EVIDENCE_COMPLETION_CONFLICT",
  ])("admits the finite receipt failure %s without admitting diagnostic suffixes", (code) => {
    expect(storedBrowserFailureCode(new Error(code))).toBe(code);
    expect(publicBrowserErrorCode(new Error(code))).toBe(code);
    expect(finalizationBrowserErrorCode(new Error(code))).toBe(code);
    const raw = new Error(code + ":fixture-private-token");
    expect(storedBrowserFailureCode(raw)).toBe("SCRY_BROWSER_COMMAND_FAILED");
    expect(publicBrowserErrorCode(raw)).toBeUndefined();
  });
  it.each([
    "SCRY_BROWSER_AUTHENTICATION_BUDGET_EXHAUSTED",
    "SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED",
  ])("preserves the finite budget refusal %s", (code) => {
    expect(storedBrowserFailureCode(new Error(code))).toBe(code);
    expect(publicBrowserErrorCode(new Error(code))).toBe(code);
    expect(finalizationBrowserErrorCode(new Error(code))).toBe(code);
    expect(storedBrowserFailureCode(new Error(code + ":private"))).toBe(
      "SCRY_BROWSER_COMMAND_FAILED",
    );
  });
  it.each(["SCRY_BROWSER_EFFECT_UNRESOLVED", "SCRY_BROWSER_SESSION_INCOMPLETE"])(
    "preserves typed recovery identifiers for %s but not arbitrary suffixes",
    (prefix) => {
      const code = prefix + ":00000000-0000-4000-8000-000000000001";
      expect(storedBrowserFailureCode(new Error(code))).toBe(code);
      expect(finalizationBrowserErrorCode(new Error(code))).toBe(code);
      expect(publicBrowserErrorCode(new Error(code))).toBeUndefined();
      expect(storedBrowserFailureCode(new Error(prefix + ":private"))).toBe(
        "SCRY_BROWSER_COMMAND_FAILED",
      );
    },
  );
  it("does not invoke arbitrary string conversion or a throwing error getter", () => {
    const untrusted = {
        toString() {
          throw new Error("fixture-only-private");
        },
      },
      error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("fixture-only-private");
      },
    });
    for (const value of [untrusted, error, "x".repeat(5000)]) {
      expect(storedBrowserFailureCode(value)).toBe("SCRY_BROWSER_COMMAND_FAILED");
      expect(publicBrowserErrorCode(value)).toBeUndefined();
      expect(finalizationBrowserErrorCode(value)).toBe("SCRY_BROWSER_FINALIZATION_FAILED");
    }
  });
  it.each([
    ["driver", 'elementHandle.fill: filling "fixture-only-password-a1b2c3"'],
    ["url", "page.goto: https://fixture.invalid/?token=fixture-only-token-a1b2c3"],
    ["database", "database failed\nDETAIL: card 4242 4242 4242 4242"],
    ["prefix spoof", "SCRY_BROWSER_PRIVATE_PASSWORD_A1B2C3"],
    ["untyped detail", "SCRY_BROWSER_CAPTURES_UNSETTLED:fixture-only-secret"],
  ])("rejects raw %s diagnostics at every public/storage sink", (_name, raw) => {
    expect(storedBrowserFailureCode(new Error(raw))).toBe("SCRY_BROWSER_COMMAND_FAILED");
    expect(publicBrowserErrorCode(new Error(raw))).toBeUndefined();
    expect(finalizationBrowserErrorCode(new Error(raw))).toBe("SCRY_BROWSER_FINALIZATION_FAILED");
  });
  it("preserves finite codes and bounded internal identifier lists", () => {
    expect(storedBrowserFailureCode(new Error("SCRY_BROWSER_OWNER_FENCED"))).toBe(
      "SCRY_BROWSER_OWNER_FENCED",
    );
    expect(publicBrowserErrorCode(new Error("SCRY_BROWSER_REFERENCE_STALE"))).toBe(
      "SCRY_BROWSER_REFERENCE_STALE",
    );
    const ids = "00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002",
      code = "SCRY_BROWSER_CAPTURES_UNSETTLED:" + ids;
    expect(storedBrowserFailureCode(new Error(code))).toBe(code);
    expect(finalizationBrowserErrorCode(new Error(code))).toBe(code);
    expect(publicBrowserErrorCode(new Error(code))).toBeUndefined();
    expect(storedBrowserFailureCode(new Error(code + ",private"))).toBe(
      "SCRY_BROWSER_COMMAND_FAILED",
    );
    expect(storedBrowserFailureCode(new Error("SCRY_BROWSER_OWNER_FENCED:private"))).toBe(
      "SCRY_BROWSER_COMMAND_FAILED",
    );
  });
});
