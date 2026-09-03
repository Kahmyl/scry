import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { browserV2ErrorStatus } from "../src/browser-execution/browser-v2-exception.filter.js";

describe("browser v2 public error classification", () => {
  it("classifies scope misses as not found rather than infrastructure failure", () => {
    expect(browserV2ErrorStatus("BROWSER_V2_PROJECT_NOT_FOUND")).toBe(HttpStatus.NOT_FOUND);
    expect(browserV2ErrorStatus("BROWSER_V2_MISSION_NOT_FOUND")).toBe(HttpStatus.NOT_FOUND);
  });

  it("keeps invariant and budget refusals conflict-classed", () => {
    expect(browserV2ErrorStatus("BROWSER_V2_BUSINESS_BUDGET_EXHAUSTED")).toBe(HttpStatus.CONFLICT);
    expect(browserV2ErrorStatus("BROWSER_V2_EFFECT_OUTCOME_PENDING")).toBe(HttpStatus.CONFLICT);
    expect(browserV2ErrorStatus("BROWSER_V2_PROTECTED_INPUT_UNAVAILABLE")).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it("reserves service unavailable for disabled or unavailable runtime capability", () => {
    expect(browserV2ErrorStatus("BROWSER_V2_CAPABILITY_DISABLED")).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(browserV2ErrorStatus("BROWSER_V2_RUNTIME_UNAVAILABLE")).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });
});
