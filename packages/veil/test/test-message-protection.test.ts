import { describe, expect, it } from "vitest";
import { protectTestMessage } from "../src/test-message-protection.js";

describe("test-message access-secret protection", () => {
  it("canonicalizes HTML entities and deduplicates the same text/HTML access link", () => {
    const link =
      "https://app.example/invite?token=fictional-invite-123&recipient=test%40example.test";
    const htmlLink = link.replaceAll("&", "&amp;");
    const result = protectTestMessage({
      text: `Accept ${link}`,
      html: [`<a href="${htmlLink}">Accept invitation</a>`],
    });
    expect(result.candidates).toEqual([{ kind: "link", value: link }]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-invite-123");
    expect(JSON.stringify(result.safe)).not.toContain("recipient=test");
  });
  it("reads quoted attributes without retaining a truncated HTML alternative", () => {
    const result = protectTestMessage({
      html: [
        "<a href='https://app.example/reset?token=fictional-reset-123&#38;next=%2Fhome'>Reset</a>",
      ],
    });
    expect(result.candidates).toEqual([
      { kind: "link", value: "https://app.example/reset?token=fictional-reset-123&next=%2Fhome" },
    ]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-reset-123");
  });
  it("preserves ordinary content and identifies verification codes and access links", () => {
    const input = {
      subject: "Welcome",
      text: "Your verification code is 123456. Order 789012 was saved. https://app.example/reset?token=fictional_access_token",
      headers: { authorization: "Bearer fictional_access_credential", cookie: "session=private" },
    };
    const result = protectTestMessage(input);
    expect(result.candidates).toEqual([
      { kind: "code", value: "123456" },
      { kind: "link", value: "https://app.example/reset?token=fictional_access_token" },
    ]);
    const safe = JSON.stringify(result.safe);
    expect(safe).not.toContain("123456");
    expect(safe).not.toContain("fictional_access_token");
    expect(safe).not.toContain("session=private");
    expect(safe).toContain("Order 789012 was saved");
    expect(safe).toContain("Welcome");
  });
  it("protects JSON OTP fields without interpreting ordinary order numbers as codes", () => {
    const result = protectTestMessage({
      verification_code: "942781",
      orderNumber: 752419,
      api_key: "fictional-api-key",
      phone: "+1234567890",
    });
    expect(result.candidates).toContainEqual({ kind: "code", value: "942781" });
    expect(JSON.stringify(result.safe)).not.toContain("942781");
    expect(JSON.stringify(result.safe)).toContain("752419");
    expect(JSON.stringify(result.safe)).toContain("+1234567890");
  });
  it("leaves documentation links and ordinary UI content readable", () => {
    const input = { text: "Read https://docs.example/help", html: ["<p>Welcome</p>"] };
    expect(protectTestMessage(input)).toEqual({ safe: input, candidates: [] });
  });
});
