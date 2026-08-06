import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { inspectPraxisCandidates } from "../src/consumer.js";

describe("Praxis real browser grounding", () => {
  it("resolves a real DOM candidate from an active page", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <button aria-label="Continue">Continue</button>
      `);

      const result = await inspectPraxisCandidates({
        page,
        intent: {
          concept: "Continue",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Continue"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: {
            requiredFamilies: [],
            minimum: 0.35,
            minimumMargin: 0.05,
            minimumFamilyCount: 1,
          },
        },
        context: {
          channel: "probe",
          ordinal: 0,
          timeoutMs: 10_000,
          allowedOrigins: ["https://example.com"],
        },
      });

      expect(result.resolution).toBe("resolved");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.confidence).toBeGreaterThan(0.35);
    } finally {
      await browser.close();
    }
  }, 15_000);
});
