import { describe, expect, it } from "vitest";
import { protectTestMessage } from "../src/test-message-protection.js";

describe("test-message access-secret protection", () => {
  it("does not mint a second claim from a square-bracketed email text link", () => {
    const link = "https://preview.example/accept#token=fictional-square-claim";
    const result = protectTestMessage({
      text: `Accept invitation [${link}]`,
      html: [`<a href="${link}">Accept as Owner</a>`],
    });
    expect(result.candidates).toEqual([
      { kind: "link", value: link, source: "html_href", label: "Accept as Owner" },
    ]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-square-claim");
  });
  it("preserves genuine punctuation and distinct destinations from authoritative anchors", () => {
    const a = "https://preview.example/accept#token=fictional-real-claim]",
      b = "https://preview.example/accept#token=fictional-second-claim";
    const result = protectTestMessage({
      html: [`<a href="${a}">Owner</a><a href="${b}">Member</a>`],
    });
    expect(result.candidates).toEqual([
      { kind: "link", value: a, source: "html_href", label: "Owner" },
      { kind: "link", value: b, source: "html_href", label: "Member" },
    ]);
  });
  it("retains balanced URL delimiters inside a wrapped link and masks secret-bearing anchor labels", () => {
    const claim = "fictional-(balanced)-claim",
      link = `https://preview.example/accept#token=${claim}`;
    const result = protectTestMessage({
      text: `[Accept](${link})`,
      html: [`<a href="${link}">${claim}</a>`],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.value).toBe(link);
    expect(JSON.stringify(result.safe)).not.toContain(claim);
    expect(result.candidates[0]?.label).not.toContain(claim);
  });
  it("does not mint a second invitation claim from a Markdown closing delimiter", () => {
    const link = "https://preview.example/accept#token=fictional-markdown-claim";
    const result = protectTestMessage({
      text: `[Accept invitation](${link})`,
      html: [`<a href="${link}">Accept invitation</a>`],
    });
    expect(result.candidates.map((c) => c.value)).toEqual([link]);
  });
  it.each(["=", "&#x3D;", "&#61;", "&equals;"])(
    "hands off fragment access links and masks their HTML spelling (%s)",
    (equals) => {
      const token = "fictional-owner-claim-20261125";
      const link = `https://preview.example/partner-team-invitations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/accept#token=${token}`;
      const html = `<a href="${link.replace("#token=", `#token${equals}`)}">Join as Owner</a>`;
      const result = protectTestMessage({ text: `Join as Owner: ${link}`, html: [html] });
      expect(result.candidates).toMatchObject([{ kind: "link", value: link }]);
      expect(JSON.stringify(result.safe)).not.toContain(token);
      expect(JSON.stringify(result.safe)).toContain("Join as Owner");
    },
  );
  it("canonicalizes HTML entities and deduplicates the same text/HTML access link", () => {
    const link =
      "https://app.example/invite?token=fictional-invite-123&recipient=test%40example.test";
    const htmlLink = link.replaceAll("&", "&amp;");
    const result = protectTestMessage({
      text: `Accept ${link}`,
      html: [`<a href="${htmlLink}">Accept invitation</a>`],
    });
    expect(result.candidates).toMatchObject([{ kind: "link", value: link }]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-invite-123");
    expect(JSON.stringify(result.safe)).not.toContain("recipient=test");
  });
  it("reads quoted attributes without retaining a truncated HTML alternative", () => {
    const result = protectTestMessage({
      html: [
        "<a href='https://app.example/reset?token=fictional-reset-123&#38;next=%2Fhome'>Reset</a>",
      ],
    });
    expect(result.candidates).toMatchObject([
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
    expect(result.candidates).toMatchObject([
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
    expect(result.candidates).toContainEqual({ kind: "code", value: "942781", source: "code" });
    expect(JSON.stringify(result.safe)).not.toContain("942781");
    expect(JSON.stringify(result.safe)).toContain("752419");
    expect(JSON.stringify(result.safe)).toContain("+1234567890");
  });
  it("leaves documentation links and ordinary UI content readable", () => {
    const input = { text: "Read https://docs.example/help", html: ["<p>Welcome</p>"] };
    expect(protectTestMessage(input)).toEqual({ safe: input, candidates: [] });
  });
  it.each([
    "?token=fictional-claim",
    "#token=fictional-claim",
    "#?access_token=fictional-claim",
    "#/accept?invitation_token=fictional-claim&role=Owner",
    "#%74oken=fictional-claim",
    "#TOKEN=fictional-claim",
    "#token=fictional-claim?still=exact",
  ])("recognizes access parameters in supported URL components: %s", (suffix) => {
    const link = `https://preview.example/accept${suffix}`;
    const result = protectTestMessage({ html: [`<a href="${link}">Accept</a>`] });
    expect(result.candidates).toMatchObject([{ kind: "link", value: link }]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-claim");
  });
  it("decodes HTML once and retains the exact URL claim bytes", () => {
    const result = protectTestMessage({
      html: [
        '<a href="https://preview.example/accept#token&#61;fictional%2Bclaim%26tail+literal&amp;next=%2Fteam">Accept</a>',
      ],
    });
    expect(result.candidates).toMatchObject([
      {
        kind: "link",
        value: "https://preview.example/accept#token=fictional%2Bclaim%26tail+literal&next=%2Fteam",
      },
    ]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional");
    const doubleEscaped = protectTestMessage({
      html: ['<a href="https://preview.example/accept#token&amp;#61;fictional">Invalid claim</a>'],
    });
    expect(doubleEscaped.candidates).toEqual([]);
  });
  it("masks encoded protocols, claim characters, other attributes and HTML text", () => {
    const encoded = "https&#58;//preview.example/accept#token&#x3D;fictional&#45;claim";
    const result = protectTestMessage({
      html: [`<a href="${encoded}" data-copy="${encoded}">Owner invitation</a><p>${encoded}</p>`],
    });
    expect(result.candidates).toMatchObject([
      { kind: "link", value: "https://preview.example/accept#token=fictional-claim" },
    ]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional");
    expect(JSON.stringify(result.safe)).toContain("Owner invitation");
  });
  it.each([
    "/accept#token=fictional-claim",
    "https://user:password@preview.example/accept#token=fictional-claim",
    "javascript:alert(0)#token=fictional-claim",
    "ftp://preview.example/accept#token=fictional-claim",
  ])("protects unusable destinations without inventing navigation: %s", (link) => {
    const result = protectTestMessage({
      html: [`<a href="${link.replace("=", "&#61;")}">Accept</a>`],
    });
    expect(result.candidates).toMatchObject([]);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-claim");
  });
  it.each(["[PROTECTED:ASSIGNMENT-SECRET]", "%5BPROTECTED%3AREFERENCE%5D"])(
    "never recovers a placeholder as a claim: %s",
    (placeholder) => {
      const result = protectTestMessage({
        text: `https://preview.example/accept#token=${placeholder}`,
      });
      expect(result.candidates).toMatchObject([]);
    },
  );
  it("protects every claim beyond the handoff cap and fails closed at size bounds", () => {
    const links = Array.from(
      { length: 25 },
      (_, i) => `https://preview.example/accept#token=fictional-claim-${i}`,
    );
    const result = protectTestMessage({
      html: links.map((link) => `<a href="${link}">Accept</a>`),
    });
    expect(result.candidates).toHaveLength(20);
    expect(JSON.stringify(result.safe)).not.toContain("fictional-claim");
    expect(protectTestMessage({ text: "x".repeat(16385) })).toEqual({
      safe: "[PROTECTED:MESSAGE_LIMIT]",
      candidates: [],
    });
  });
  it("retains legacy path links and ordinary fragment documentation", () => {
    const input = {
      text: "Read https://docs.example/guide#install and https://docs.example/#/help?section=Owner",
    };
    expect(protectTestMessage(input)).toEqual({ safe: input, candidates: [] });
    expect(
      protectTestMessage({ text: "https://preview.example/invite/fictional_path_claim" })
        .candidates,
    ).toHaveLength(1);
  });
  it("handles a deterministic matrix of entity spellings without changing navigation bytes", () => {
    const spellings = ["=", "&#61;", "&#x3d;", "&#x3D;", "&equals;"];
    for (const equals of spellings) {
      for (const ampersand of ["&amp;", "&#38;", "&#x26;"]) {
        for (const quote of ["'", '"']) {
          const canonical =
            "https://preview.example/accept#token=fictional-matrix-claim&next=%2Fteam";
          const encoded = canonical
            .replace("=fictional", `${equals}fictional`)
            .replace("&next", `${ampersand}next`);
          const result = protectTestMessage({
            html: [`<a href=${quote}${encoded}${quote}>Join Owner</a>`],
            text: canonical,
          });
          expect(result.candidates).toMatchObject([{ kind: "link", value: canonical }]);
          expect(JSON.stringify(result.safe)).not.toContain("fictional-matrix-claim");
        }
      }
    }
  });
  it("protects encoded verification codes in parsed HTML text and inactive templates", () => {
    const result = protectTestMessage({
      html: [
        "<template><a href='https://preview.example/accept#token&#61;fictional-template-claim'>Owner invitation</a></template><p>Your verification code is &#49;&#50;&#51;&#52;&#53;&#54;</p>",
      ],
    });
    expect(result.candidates).toContainEqual({
      kind: "link",
      value: "https://preview.example/accept#token=fictional-template-claim",
      source: "html_href",
      label: "Owner invitation",
    });
    expect(result.candidates).toContainEqual({ kind: "code", value: "123456", source: "code" });
    expect(JSON.stringify(result.safe)).not.toContain("fictional-template-claim");
    expect(JSON.stringify(result.safe)).not.toContain("&#49;");
  });
});
