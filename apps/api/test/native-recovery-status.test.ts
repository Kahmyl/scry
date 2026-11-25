import { expect, it } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { runRecoveryStatus } from "../src/browser-execution/customer-reporting.js";
import { BrowserExceptionFilter } from "../src/browser-execution/browser-exception.filter.js";
import { NativeActionReconciliationRequired } from "../src/browser-execution/native-action-recovery.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const active = {
  id,
  state: "running",
  browserSessionState: "active",
  runtimeAdapter: "playwright_mcp",
  inspectionOwnerLive: true,
  stopRequestedAt: null,
  uncertainCommandId: id,
  uncertainErrorCode: "SCRY_BROWSER_ADAPTER_OBSERVATION_INVALIDATED",
  pendingCommandCount: 0,
};
it("offers permitted observations and one stable incident without promising runtime availability", () => {
  const r = runRecoveryStatus(active);
  expect(r.recovery).toMatchObject({
    incidentId: "scry-command-" + id,
    mutationsAllowed: false,
    availability: "revalidated_on_submission",
  });
  expect(r.recovery?.admissionAllowedTools).toContain("browser_snapshot");
  expect(r.recovery?.admissionAllowedTools).not.toContain("browser_scoped_request");
});
it.each([
  { inspectionOwnerLive: false },
  { runtimeAdapter: "legacy" },
  { stopRequestedAt: new Date() },
  { state: "failed" },
  { uncertainErrorCode: "SCRY_BROWSER_ADAPTER_TIMEOUT" },
  { uncertainErrorCode: "SCRY_BROWSER_ADAPTER_LOST" },
])("does not advertise browser inspection for an ineligible runtime %j", (facts) => {
  expect(runRecoveryStatus({ ...active, ...facts }).recovery?.admissionAllowedTools).toEqual([]);
});
it("correlates only the typed service refusal and does not invent a newly allocated command", () => {
  const capture = (error: Error) => {
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
  const body = capture(new NativeActionReconciliationRequired(id));
  expect(body).toMatchObject({
    incidentId: "scry-command-" + id,
    relatedCommandId: id,
    admission: "refused_before_allocation",
  });
  expect(body).not.toHaveProperty("commandId");
  expect(body.interaction.next).toMatchObject({ actor: "agent", tool: "get_command" });
  expect(
    capture(
      Object.assign(new Error("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED"), {
        relatedCommandId: "PRIVATE_VALUE",
      }),
    ),
  ).not.toHaveProperty("relatedCommandId");
});
it("includes the current command identity so pending guidance does not require discovery", () => {
  const r = runRecoveryStatus({
    ...active,
    uncertainCommandId: undefined,
    currentCommandId: id,
    pendingCommandCount: 1,
  });
  expect(r.currentCommandId).toBe(id);
  expect(r.interaction.next).toMatchObject({ tool: "get_command" });
});
