import { describe, expect, it } from "vitest";

import { decryptCredential, encryptCredential } from "../src/access/index.js";

describe("credential encryption", () => {
  it("round-trips a credential without storing plaintext", () => {
    const plaintext = "private-test-value";
    const encrypted = encryptCredential(plaintext);

    expect(encrypted.ciphertext.toString("utf8")).not.toContain(plaintext);
    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("uses a fresh initialization vector for every encryption", () => {
    const first = encryptCredential("same-value");
    const second = encryptCredential("same-value");

    expect(first.initializationVector.equals(second.initializationVector)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});
