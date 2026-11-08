import { describe, expect, it } from "vitest";
import { reportNavigation } from "../src/saved-report-tools.js";

const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
describe("trusted report navigation origin", () => {
  it("uses the existing validated OAuth resource origin without new configuration", () => {
    const links = reportNavigation({
      SCRY_OAUTH_ENABLED: "true",
      SCRY_OAUTH_RESOURCE: "https://scry.example/mcp",
      SCRY_OAUTH_ISSUER: "https://scry.example/oauth",
    })(reportId);
    expect(links).toEqual({
      reportUrl: `https://scry.example/dashboard/reports/${reportId}`,
      evidenceUrl: `https://scry.example/dashboard/reports/${reportId}#supporting-evidence`,
    });
  });
  it("omits links without a configured dashboard instead of exposing an internal API host", () => {
    expect(reportNavigation({ SCRY_API_BASE_URL: "http://api:4000/api" })(reportId)).toEqual({});
  });
  it("allows the explicit loopback development UI and rejects malformed IDs", () => {
    const links = reportNavigation({ SCRY_WEB_ORIGIN: "http://127.0.0.1:5173" });
    expect(links(reportId).reportUrl).toBe(`http://127.0.0.1:5173/dashboard/reports/${reportId}`);
    expect(links("../operator")).toEqual({});
    expect(links(null)).toEqual({});
  });
  it.each([
    "http://public.example",
    "https://user:password@scry.example",
    "https://scry.example/other",
    "https://scry.example/?token=secret",
    "https://scry.example/#fragment",
    "javascript:alert(1)",
  ])("rejects unsafe or non-origin configuration %s", (origin) => {
    expect(() => reportNavigation({ SCRY_WEB_ORIGIN: origin })).toThrow();
  });
  it("rejects disagreement with the authorized resource origin", () => {
    expect(() =>
      reportNavigation({
        SCRY_OAUTH_ENABLED: "true",
        SCRY_OAUTH_RESOURCE: "https://scry.example/mcp",
        SCRY_OAUTH_ISSUER: "https://scry.example/oauth",
        SCRY_WEB_ORIGIN: "https://other.example",
      }),
    ).toThrow("SCRY_WEB_ORIGIN_INVALID");
  });
});
