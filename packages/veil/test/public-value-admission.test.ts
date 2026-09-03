import { describe, expect, it } from "vitest";

import {
  VeilPublicValueAdmissionError,
  admitVeilPublicValue,
  classifyVeilPublicValue,
} from "../src/public-value-admission.js";

describe("Veil public value admission", () => {
  const publicCandidate = (text: string) => ({
    kind: "annotated" as const,
    text,
    redactedBoundary: false,
    editableBoundary: false,
  });

  it("admits an ordinary exact public endpoint path", () => {
    const admitted = admitVeilPublicValue({
      kind: "code",
      text: "/api/v1/partner/reservations/{reservationId}",
      redactedBoundary: false,
      editableBoundary: false,
      contextLabel: "Retrieve reservation",
    });

    expect(admitted).toMatchObject({
      classification: "public",
      admissionRevision: 1,
      safeContext: "Retrieve reservation",
    });

    expect(admitted.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(admitted.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a redacted sibling without returning its text", () => {
    const secret = "sk_live_this_value_must_never_escape_123456";

    expect(
      classifyVeilPublicValue({
        kind: "code",
        text: secret,
        redactedBoundary: true,
        editableBoundary: false,
      }),
    ).toBe("protected");

    try {
      admitVeilPublicValue({
        kind: "code",
        text: secret,
        redactedBoundary: true,
        editableBoundary: false,
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VeilPublicValueAdmissionError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it("refuses obvious credential material even without a DOM redaction marker", () => {
    expect(
      classifyVeilPublicValue({
        kind: "code",
        text: "Authorization: Bearer eyJabc123456789.eyJdef123456789.signature123456789",
        redactedBoundary: false,
        editableBoundary: false,
      }),
    ).toBe("protected");
  });

  it("admits explicit documentation placeholders only as complete sensitive-label values", () => {
    for (const text of [
      "access_token=<ACCESS_TOKEN>",
      "client_secret=<YOUR_CLIENT_SECRET>",
      "https://docs.example.test/reference#access_token=<EXAMPLE_ACCESS_TOKEN>",
    ]) {
      expect(admitVeilPublicValue(publicCandidate(text))).toMatchObject({
        classification: "public",
      });
    }
  });

  it.each([
    "access_token=sk_live_realistic_sensitive_value",
    "access_token=<sk_live_realistic_sensitive_value>",
    "access_token=<AbCdEf1234567890>",
    "access_token=<ABCDEF123456789012345678901234567890>",
    "access_token=<ACCESS_TOKEN>suffix",
    "access_token=prefix<ACCESS_TOKEN>",
    "access_token=<<ACCESS_TOKEN>>",
    "access_token=%3CACCESS_TOKEN%3E",
    "access_token=<ACCESS-TOKEN>",
    '"client_secret":"refused-example-value"',
  ])("keeps ambiguous or credential-like sensitive values protected: %s", (text) => {
    expect(classifyVeilPublicValue(publicCandidate(text))).toBe("protected");
  });

  it("admits a public documentation example while refusing a whole document with a real secret", () => {
    const publicDocument = JSON.stringify({
      documentation: Array.from({ length: 128 }, (_, index) => ({ index, description: "public" })),
      example: "https://docs.example.test/reference#access_token=<EXAMPLE_ACCESS_TOKEN>",
    });
    expect(admitVeilPublicValue(publicCandidate(publicDocument))).toMatchObject({
      classification: "public",
    });

    const withRealSecret = publicDocument.replace(
      "<EXAMPLE_ACCESS_TOKEN>",
      "sk_live_realistic_sensitive_value",
    );
    expect(classifyVeilPublicValue(publicCandidate(withRealSecret))).toBe("protected");
    expect(() => admitVeilPublicValue(publicCandidate(withRealSecret))).toThrow(
      "VEIL_PUBLIC_VALUE_PROTECTED",
    );
  });

  it("does not treat an empty value as public", () => {
    expect(
      classifyVeilPublicValue({
        kind: "output",
        text: "   ",
        redactedBoundary: false,
        editableBoundary: false,
      }),
    ).toBe("unknown");
  });
});
