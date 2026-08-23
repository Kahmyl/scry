// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../infrastructure/api/client.js";
import { OperationalEventsView } from "./operational-events.js";

vi.mock("../../infrastructure/api/client.js", async (load) => ({
  ...(await load<typeof import("../../infrastructure/api/client.js")>()),
  api: vi.fn(),
  apiBlob: vi.fn(),
}));

describe("operational diagnostics dashboard", () => {
  beforeEach(() => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith("/operations/summary"))
        return {
          generatedAt: "2026-08-23T10:00:00.000Z",
          windowStartedAt: "2026-08-22T10:00:00.000Z",
          totalEvents: 1,
          byClassification: { reconciliation_unknown: 1 },
          alerts: [
            {
              type: "unknown_protected_operation",
              severity: "critical",
              count: 1,
              safeAction: "Inspect the receipt and reconcile before redispatch.",
            },
          ],
        } as never;
      return {
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            occurredAt: "2026-08-23T09:59:00.000Z",
            name: "protected_operation.reconciliation_required",
            component: "runtime",
            classification: "reconciliation_unknown",
            reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
            outcome: "reconciliation_required",
            releaseId: "release-1",
            schemaFingerprint: "schema-1",
            causality: {
              missionId: "mission-1",
              correlationId: "correlation-1",
            },
          },
        ],
      } as never;
    });
  });

  it("shows active alerts, safe action, and a causal drill-down", async () => {
    render(<OperationalEventsView projectId="project-1" />);

    expect(await screen.findByText("unknown protected operation")).toBeTruthy();
    expect(screen.getByText(/reconcile before redispatch/i)).toBeTruthy();
    expect(screen.getByText("MUTATION_RECONCILIATION_REQUIRED")).toBeTruthy();

    screen.getByRole("button", { name: /correlationId: correlation-1/i }).click();
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("correlationId=correlation-1")),
    );
  });
});
