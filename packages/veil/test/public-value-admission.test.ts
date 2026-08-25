import { describe, expect, it } from "vitest";

import {
  VeilPublicValueAdmissionError,
  admitVeilPublicValue,
  classifyVeilPublicValue,
} from "../src/public-value-admission.js";

describe("Veil public value admission", () => {
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
