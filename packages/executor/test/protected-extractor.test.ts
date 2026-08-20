import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { acquireValue } from "../src/protected-extractor.js";

describe("protected semantic extraction", () => {
  it("adapts a field-shaped semantic target across field, static, definition, and delayed output shapes", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      const acquisition = {
        target: {
          concept: "generated client id",
          requiredCapabilities: ["readable_value" as const],
          preferredEvidence: {
            roles: ["textbox" as const],
            names: ["Client ID"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" as const },
          relations: [],
          prohibited: ["hidden" as const, "disabled" as const],
          risk: "protected" as const,
          confidence: { requiredFamilies: [] },
        },
        classification: "public" as const,
        permittedMethods: [
          "semantic_field_value" as const,
          "input_value" as const,
          "text_content" as const,
          "copy_control" as const,
        ],
        objective: { kind: "capture_value" as const, expectedValueType: "public" as const },
        validation: { minimumLength: 1, maximumLength: 100 },
      };

      await page.setContent(`<label>Client ID<input value="field-client-id"></label>`);
      expect((await acquireValue(page, acquisition, 500)).value).toBe("field-client-id");

      await page.setContent(`<output aria-label="Client ID">static-client-id</output>`);
      expect((await acquireValue(page, acquisition, 500)).value).toBe("static-client-id");

      await page.setContent(`<dl><dt>Client ID</dt><dd>definition-client-id</dd></dl>`);
      expect((await acquireValue(page, acquisition, 500)).value).toBe("definition-client-id");

      await page.setContent(
        `<dl><dt>Client ID</dt><dd></dd></dl><script>setTimeout(() => document.querySelector('dd').textContent = 'delayed-client-id', 100)</script>`,
      );
      expect((await acquireValue(page, acquisition, 800)).value).toBe("delayed-client-id");
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("never captures a semantic label, hidden decoy, or ambiguous duplicate as an output value", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      const acquisition = {
        target: {
          concept: "generated client secret",
          requiredCapabilities: ["readable_value" as const],
          preferredEvidence: {
            roles: ["textbox" as const],
            names: ["Client secret"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" as const },
          relations: [],
          prohibited: ["hidden" as const, "disabled" as const],
          risk: "protected" as const,
          confidence: { requiredFamilies: [] },
        },
        classification: "unknown_secret" as const,
        permittedMethods: ["semantic_field_value" as const, "text_content" as const],
        objective: { kind: "capture_value" as const, expectedValueType: "unknown_secret" as const },
        validation: { minimumLength: 1, maximumLength: 100 },
      };

      await page.setContent(`<span aria-label="Client secret">Client secret</span>`);
      const labelOnly = await acquireValue(page, acquisition, 150);
      expect(labelOnly.value).toBeUndefined();
      expect(
        labelOnly.diagnostics.some(
          (item) => item.lastFailureCode === "VALUE_MATCHES_SEMANTIC_IDENTITY",
        ),
      ).toBe(true);

      await page.setContent(
        `<output aria-label="Client secret" hidden>hidden-decoy</output><output aria-label="Client secret">visible-secret</output>`,
      );
      const visible = await acquireValue(page, acquisition, 500);
      expect(visible.value, JSON.stringify(visible.diagnostics)).toBe("visible-secret");

      await page.setContent(
        `<dl><dt>Client secret</dt><dd>secret-one</dd><dt>Client secret</dt><dd>secret-two</dd></dl>`,
      );
      const duplicate = await acquireValue(page, acquisition, 150);
      expect(duplicate.value).toBeUndefined();
      expect(JSON.stringify(duplicate.diagnostics)).not.toContain("secret-one");
      expect(JSON.stringify(duplicate.diagnostics)).not.toContain("secret-two");
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("resolves the nearest following definition value across direct and wrapped labels", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      const acquisition = {
        target: {
          concept: "Client secret value",
          requiredCapabilities: ["readable_value" as const],
          preferredEvidence: {
            roles: ["value" as const],
            names: ["Client secret"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" as const },
          relations: [{ kind: "following" as const, name: "Client secret" }],
          prohibited: ["hidden" as const],
          risk: "protected" as const,
          confidence: {
            requiredFamilies: [],
            minimum: 0.3,
            minimumMargin: 0,
            minimumFamilyCount: 1,
          },
        },
        classification: "unknown_secret" as const,
        permittedMethods: ["semantic_field_value" as const],
        validation: { minimumLength: 1, maximumLength: 100 },
      };

      await page.setContent("<dl><div><dt>Client secret</dt><dd>direct-secret</dd></div></dl>");
      expect((await acquireValue(page, acquisition, 500)).value).toBe("direct-secret");

      await page.setContent(
        "<dl><div><div><dt>Client secret</dt><button>Copy</button></div><dd>wrapped-secret</dd></div></dl>",
      );
      expect((await acquireValue(page, acquisition, 500)).value).toBe("wrapped-secret");
    } finally {
      await browser.close();
    }
  });
});
