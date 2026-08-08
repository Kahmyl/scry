import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { inspectPraxisCandidates } from "../src/consumer.js";

describe("Praxis candidate resolution", () => {
  it("resolves a pointer-activatable link row from exact expected text", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();
      await page.setContent(`
        <table><tbody>
          <tr role="link" onclick="void 0">
            <td><a href="/applications/scry">Scry Acceptance 2026-08-08 1502</a></td>
            <td>Test</td><td>active</td>
          </tr>
        </tbody></table>
      `);

      const result = await inspectPraxisCandidates({
        page,
        intent: {
          concept: "the created Test application row",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["link"],
            names: [],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            expectedText: "Scry Acceptance 2026-08-08 1502 Test active",
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: { requiredFamilies: [] },
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
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("returns resolved with a resumable candidate when exactly one target remains", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <button>Continue</button>
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
      expect(result.candidates[0]).toMatchObject({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        resumeToken: {
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("returns an agent-choice state for ambiguous targets", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <button>Continue</button>
        <button>Continue</button>
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

      expect(result.resolution).toBe("needs_agent_choice");
      expect(result.policy).toMatchObject({
        allowsAgentCandidateChoice: true,
        allowsSelectorHint: true,
        requiresExplicitAuthorization: false,
      });
      expect(result.candidates.length).toBe(2);
      expect(result.candidates[0]).toMatchObject({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        resumeToken: expect.objectContaining({
          intentDigest: result.diagnostic.intentDigest,
        }),
      });
      expect(JSON.stringify(result.candidates)).not.toContain("locator");
      expect(JSON.stringify(result.candidates)).not.toContain("frame");
      expect(result.diagnostic.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("returns blocked for impossible targets", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();
      await page.setContent("");

      const result = await inspectPraxisCandidates({
        page,
        intent: {
          concept: "Save",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Save"],
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

      expect(result.resolution).toBe("blocked");
      expect(result.candidates).toEqual([]);
      expect(result.diagnostic.intentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.diagnostic.documentEpoch).toBeGreaterThanOrEqual(0);
    } finally {
      await browser.close();
    }
  }, 15_000);
});

describe("candidate resume validation", () => {
  it("rejects expired resume tokens", async () => {
    const { validateCandidateResumeToken } = await import("../src/grounding.js");

    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await expect(
        validateCandidateResumeToken(page, {
          id: "resume-1",
          intentDigest: "a".repeat(64),
          fingerprint: "b".repeat(64),
          documentEpoch: 0,
          expiresAt: new Date(0).toISOString(),
        }),
      ).rejects.toMatchObject({
        code: "TARGET_CHANGED_BEFORE_ACTION",
      });
    } finally {
      await browser.close();
    }
  }, 15_000);
});

describe("candidate fingerprint fencing", () => {
  it("rejects a resume token when the semantic target changed", async () => {
    const { validateCandidateResume } = await import("../src/grounding.js");

    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`<button>Save</button>`);

      await expect(
        validateCandidateResume(
          page,
          {
            id: "resume-1",
            intentDigest: "a".repeat(64),
            fingerprint: "b".repeat(64),
            documentEpoch: 0,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
          {
            concept: "Save",
            requiredCapabilities: ["pointer_activatable"],
            preferredEvidence: {
              roles: ["button"],
              names: ["Save"],
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
        ),
      ).rejects.toMatchObject({
        code: "TARGET_CHANGED_BEFORE_ACTION",
      });
    } finally {
      await browser.close();
    }
  }, 15_000);
});

describe("risk-aware candidate resolution", () => {
  it("does not expose destructive ambiguity as an agent choice", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <button>Delete</button>
        <button>Delete</button>
      `);

      const result = await inspectPraxisCandidates({
        page,
        intent: {
          concept: "Delete",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Delete"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "destructive",
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

      expect(result.resolution).toBe("needs_scoped_inspection");
      expect(result.policy).toMatchObject({
        allowsAgentCandidateChoice: false,
        requiresExplicitAuthorization: true,
      });
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("allows ordinary ambiguity to remain agent selectable", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <button>Continue</button>
        <button>Continue</button>
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

      expect(result.resolution).toBe("needs_agent_choice");
    } finally {
      await browser.close();
    }
  }, 15_000);
});
