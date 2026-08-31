import { describe, expect, it } from "vitest";
import { createProtectedInputVerification } from "../src/runtime/protected-transactions/protected-input-verification.js";

describe("one-use presentation comparison evidence", () => {
  it("verifies exact and substring assertions without resolving or retaining plaintext", () => {
    const verification = createProtectedInputVerification();
    verification.remember("asset-field", "protected-canary");
    expect(verification.matches("asset-field", "protected-canary", true)).toBe(true);
    expect(verification.matches("asset-field", "prefix protected-canary suffix", false)).toBe(true);
    expect(verification.matches("asset-field", "wrong", true)).toBe(false);
    expect(verification.matches("other-field", "protected-canary", true)).toBe(false);
    expect(JSON.stringify(verification)).not.toContain("protected-canary");
    expect(() => verification.remember("asset-field", "protected-canary")).toThrow(
      "PROTECTED_INPUT_PRESENTATION_REPEATED",
    );
    verification.dispose();
    expect(verification.matches("asset-field", "protected-canary", true)).toBe(false);
    expect(() => verification.remember("new-field", "protected-canary")).toThrow();
  });
});
