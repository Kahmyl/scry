import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { InteractionTargetIntent } from "@scry/contracts";
import { resolveTarget } from "../src/grounding.js";
import { resolveVisualAnchors } from "../src/visual-grounding.js";

const visualIntent = (
  overrides: Partial<InteractionTargetIntent> = {},
): InteractionTargetIntent => ({
  concept: "Save",
  requiredCapabilities: ["pointer_activatable"],
  preferredEvidence: {
    roles: ["button"],
    names: ["Save"],
    labels: [],
    descriptions: [],
    placeholders: [],
    inputTypes: [],
    visual: { sources: ["ocr", "geometry"], expectedText: "Save", protectedUse: false },
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.5, minimumMargin: 0, minimumFamilyCount: 2 },
  ...overrides,
});
describe("deterministic visual evidence", () => {
  it("returns OCR anchors rather than action locators", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
      await page.setContent(
        `<style>body{background:white;color:black;font:32px Arial}</style><button>Save</button>`,
      );
      const anchors = await resolveVisualAnchors(page, page.locator("body"), visualIntent());
      expect(anchors.some((item) => item.text.toLowerCase().includes("save"))).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
  it("fuses an icon anchor with the compatible button", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<button aria-label="Copy"><svg data-icon="copy"><title>Copy</title></svg></button>`,
      );
      const result = await resolveTarget(
        page,
        visualIntent({
          concept: "Copy",
          preferredEvidence: {
            roles: ["button"],
            names: ["Copy"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            visual: {
              sources: ["icon", "geometry"],
              icon: "copy",
              expectedText: "Copy",
              protectedUse: false,
            },
          },
        }),
      );
      expect(result.locator).toBeDefined();
      expect(result.diagnostic.resolutionSource).toBe("unified");
    } finally {
      await browser.close();
    }
  }, 15_000);
  it("never selects a display-only OCR label for text entry", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div>Password</div><button>Password help</button>`);
      await expect(
        resolveTarget(
          page,
          visualIntent({
            concept: "Password",
            requiredCapabilities: ["focusable", "accepts_text", "editable"],
            preferredEvidence: {
              roles: ["textbox"],
              names: ["Password"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: ["password"],
              visual: { sources: ["geometry"], expectedText: "Password", protectedUse: false },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "NO_CAPABILITY_COMPATIBLE_CONTROL" });
    } finally {
      await browser.close();
    }
  }, 15_000);
});
