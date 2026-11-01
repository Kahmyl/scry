import { describe, expect, it } from "vitest";

import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";

describe("browser boundary composition", () => {
  it("adapts the current protection authority without exposing it to report persistence", () => {
    const secret = "tok_boundary_secret_112233445566";
    const released = "resource-public-112233445566";
    const protection = new BrowserRuntimeVeilReportProtection().createReportSanitizer({
      scope: {
        projectId: "00000000-0000-4000-8000-000000000001",
        missionId: "00000000-0000-4000-8000-000000000002",
        runId: "report:00000000-0000-4000-8000-000000000002",
        sessionId: "report:00000000-0000-4000-8000-000000000002",
        origin: "report://00000000-0000-4000-8000-000000000002",
      },
      protectedValues: { secret },
      restoredPublicValues: [{ value: released, allowedSinks: ["report"] }],
    });

    const sanitized = protection.sanitizeValue(
      {
        summary: `kept ${released}`,
        detail: `removed ${secret}`,
      },
      "report",
    );

    expect(JSON.stringify(sanitized)).toContain(released);
    expect(JSON.stringify(sanitized)).not.toContain(secret);
  });
});
