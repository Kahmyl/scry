import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { browserErrorStatus } from "../src/browser-execution/browser-exception.filter.js";
import { BrowserExceptionFilter } from "../src/browser-execution/browser-exception.filter.js";
import type { ArgumentsHost } from "@nestjs/common";

describe("browser baseline public error classification", () => {
  it("explains pre-launch capacity refusal without leaking other tenants or encouraging write replay", () => {
    let status: number | undefined, body: any;
    const response = {
      status: (value: number) => {
        status = value;
        return response;
      },
      send: (value: unknown) => {
        body = value;
      },
    };
    new BrowserExceptionFilter().catch(new Error("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED"), {
      switchToHttp: () => ({ getResponse: () => response }),
    } as ArgumentsHost);
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.code).toBe("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    expect(body.safeActions.join(" ")).toContain("launched no browser");
    expect(body.safeActions.join(" ")).toContain("same start request");
    expect(body.safeActions.join(" ")).toContain("Do not repeat any prior business action");
  });
  it("classifies scope misses as not found rather than infrastructure failure", () => {
    expect(browserErrorStatus("SCRY_BROWSER_PROJECT_NOT_FOUND")).toBe(HttpStatus.NOT_FOUND);
    expect(browserErrorStatus("SCRY_BROWSER_MISSION_NOT_FOUND")).toBe(HttpStatus.NOT_FOUND);
  });

  it("keeps invariant and budget refusals conflict-classed", () => {
    expect(browserErrorStatus("SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED")).toBe(HttpStatus.CONFLICT);
    expect(browserErrorStatus("SCRY_BROWSER_EFFECT_OUTCOME_PENDING")).toBe(HttpStatus.CONFLICT);
    expect(browserErrorStatus("SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE")).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it("reserves service unavailable for disabled or unavailable runtime capability", () => {
    expect(browserErrorStatus("SCRY_BROWSER_CAPABILITY_DISABLED")).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(browserErrorStatus("SCRY_BROWSER_RUNTIME_UNAVAILABLE")).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });
});
