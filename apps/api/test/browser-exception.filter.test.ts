import { ConflictException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { browserErrorStatus } from "../src/browser-execution/browser-exception.filter.js";
import { BrowserExceptionFilter } from "../src/browser-execution/browser-exception.filter.js";
import type { ArgumentsHost } from "@nestjs/common";

describe("browser baseline public error classification", () => {
  it("adds finite recovery to admitted and HttpException envelopes without echoing arbitrary errors", () => {
    const capture = (error: unknown) => {
      let body: any;
      const response = {
        status: () => response,
        send: (value: unknown) => {
          body = value;
        },
      };
      new BrowserExceptionFilter().catch(error, {
        switchToHttp: () => ({ getResponse: () => response }),
      } as ArgumentsHost);
      return body;
    };
    expect(
      capture(new Error("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED")).interaction,
    ).toMatchObject({ state: "unknown", applicationConclusion: "not_determined" });
    const http = capture(
      new ConflictException({
        code: "SCRY_BROWSER_COMMAND_STOP_REQUESTED",
        safeActions: ["Keep existing status checks"],
      }),
    );
    expect(http.safeActions).toEqual(["Keep existing status checks"]);
    expect(http.interaction).toMatchObject({ state: "stopping" });
    const unknown = capture(new Error("PRIVATE_DIAGNOSTIC_VALUE"));
    expect(unknown.interaction).toMatchObject({ state: "unknown" });
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE_DIAGNOSTIC_VALUE");
  });
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

  it.each([
    ["SCRY_BROWSER_PROJECT_NOT_FOUND", "list_projects"],
    ["SCRY_BROWSER_REFERENCE_STALE", "get_run_status"],
    ["SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE", "list_credentials"],
    ["SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED", "finish_incomplete_run"],
  ])("retains finite agent-owned recovery for admitted %s", (code, tool) => {
    let body: any;
    const response = {
      status: () => response,
      send: (value: unknown) => {
        body = value;
      },
    };
    new BrowserExceptionFilter().catch(new Error(code), {
      switchToHttp: () => ({ getResponse: () => response }),
    } as ArgumentsHost);
    expect(body.code).toBe(code);
    expect(body.interaction.next.tool).toBe(tool);
    expect(body.interaction.applicationConclusion).toBe("not_determined");
    expect(body.safeActions).toBeInstanceOf(Array);
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
