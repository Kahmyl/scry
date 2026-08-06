import { describe, expect, it } from "vitest";

import {
  createAuthoringBrowserSession,
} from "../src/index.js";

import { inspectPraxisCandidates } from "@scry/praxis";

describe("authoring browser Praxis grounding", () => {
  it("grounds against the owned authoring browser page", async () => {
    const session = await createAuthoringBrowserSession({
      sessionId: "test-session",
      environmentId: "test-environment",
      veilAdmissionKey: "test-key",
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      policy: {
        allowedOrigins: ["https://example.com"],
        allowPrivateNetwork: false,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 5,
        maxDurationMs: 30_000,
        maxNavigations: 1,
      },
    });

    try {
      await session.page.setContent(`
        <button aria-label="Continue">Continue</button>
      `);

      const result = await inspectPraxisCandidates({
        page: session.page,
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
    } finally {
      await session.close();
    }
  }, 30_000);
});
