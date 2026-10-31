import { describe, expect, it } from "vitest";
import { browserSessionLimit } from "../src/browser-execution/repositories/browser-session-capacity.js";

describe("live browser capacity configuration", () => {
  it("defaults to one live session and admits only bounded positive integers", () => {
    expect(browserSessionLimit({})).toBe(1);
    expect(browserSessionLimit({ SCRY_BROWSER_MAX_LIVE_SESSIONS: "3" })).toBe(3);
    expect(browserSessionLimit({ SCRY_BROWSER_MAX_LIVE_SESSIONS: "1000" })).toBe(1000);
    for (const value of ["", "0", "-1", "Infinity", "NaN", "1.5", "01", " 1", "1001"])
      expect(() => browserSessionLimit({ SCRY_BROWSER_MAX_LIVE_SESSIONS: value })).toThrow(
        "SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID",
      );
  });
});
