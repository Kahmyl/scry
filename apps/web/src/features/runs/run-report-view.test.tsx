// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Report } from "../../infrastructure/api/client.js";
import { api } from "../../infrastructure/api/client.js";
import { ReportView } from "./run-report-view.js";

vi.mock("../../infrastructure/api/client.js", async (load) => ({
  ...(await load<typeof import("../../infrastructure/api/client.js")>()),
  api: vi.fn(),
  apiBlob: vi.fn().mockResolvedValue(new Blob(["artifact"])),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("Run report view", () => {
  it("exits the initial skeleton on failure and retries the request", async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("Request failed (500)"))
      .mockResolvedValueOnce(reportFixture());

    render(<ReportView runId="run-1" onBack={vi.fn()} onOpenReport={vi.fn()} />);

    expect(await screen.findByText("Run details unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Fixture run")).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("places evidence before a collapsed Advanced disclosure", async () => {
    vi.mocked(api).mockResolvedValue(reportFixture());
    const view = render(<ReportView runId="run-1" onBack={vi.fn()} onOpenReport={vi.fn()} />);

    await screen.findByText("Fixture run");
    const advanced = view.container.querySelector<HTMLDetailsElement>("#advanced");
    expect(advanced?.open).toBe(false);
    const evidence = screen.getByText("Captured evidence").closest(".panel");
    expect(
      Boolean(
        evidence &&
        advanced &&
        evidence.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(screen.getByText("This run completed without an available screenshot.")).toBeTruthy();

    const summary = screen.getByText("Advanced").closest("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary!);
    expect(advanced?.open).toBe(true);
    expect(screen.getByText("Veil privacy")).toBeTruthy();
    expect(screen.getByText("Praxis interactions")).toBeTruthy();
  });

  it("opens Advanced from a supported query deep link", async () => {
    window.history.replaceState({}, "", "/runs/run-1?advanced=1");
    vi.mocked(api).mockResolvedValue(reportFixture());
    const view = render(<ReportView runId="run-1" onBack={vi.fn()} onOpenReport={vi.fn()} />);

    await waitFor(() =>
      expect(view.container.querySelector<HTMLDetailsElement>("#advanced")?.open).toBe(true),
    );
  });

  it("renders only the safe protected-operation receipt projection", async () => {
    const report = reportFixture();
    Object.assign(report.privacy.mutationReceipts[0]!, {
      plaintext: "MUST_NOT_RENDER_PROTECTED_VALUE",
    });
    vi.mocked(api).mockResolvedValue(report);
    const view = render(<ReportView runId="run-1" onBack={vi.fn()} onOpenReport={vi.fn()} />);

    await screen.findByText("Fixture run");
    fireEvent.click(screen.getByText("Advanced").closest("summary")!);

    expect(screen.getByText("Protected operations")).toBeTruthy();
    expect(screen.getByText("1 RECEIPTS")).toBeTruthy();
    expect(screen.getByText("protected mutation · applied")).toBeTruthy();
    expect(
      screen.getByText(
        "dispatch acknowledged · persistence committed · reconciliation proven applied",
      ),
    ).toBeTruthy();
    expect(screen.getByText("redispatch blocked · 2 stored references")).toBeTruthy();
    expect(screen.getByText(/client_secret · protected · project · credential-1/)).toBeTruthy();
    expect(screen.queryByText("MUST_NOT_RENDER_PROTECTED_VALUE")).toBeNull();
  });
});

function reportFixture(): Report {
  return {
    run: {
      id: "run-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      state: "passed",
      planName: "Fixture run",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
      attemptCount: 1,
      needsAttention: false,
      environmentSnapshot: { name: "Fixture", baseOrigin: "https://example.test" },
      executionSnapshot: { browser: "chromium", viewport: { width: 1280, height: 720 }, seed: 1 },
      planSnapshot: { name: "Fixture run", objective: "Verify the fixture", steps: [] },
      policySnapshot: {},
    },
    attempts: [{ id: "attempt-1", attemptNumber: 1, state: "passed" }],
    currentAttempt: { id: "attempt-1", attemptNumber: 1, state: "passed" },
    events: [],
    steps: [],
    artifacts: [],
    artifactTimeline: [],
    privacy: {
      intervals: [],
      operations: [],
      mutationReceipts: [
        {
          receiptId: "receipt-1",
          operationId: "operation-1",
          owner: { kind: "authoring_session", id: "praxis-1" },
          correlation: {
            projectId: "project-1",
            environmentId: "environment-1",
            missionId: "mission-1",
            objectiveId: "objective-1",
            agentSessionId: "agent-1",
            runId: "run-1",
            praxisSessionId: "praxis-1",
          },
          operationClass: "protected_mutation",
          dispatch: { state: "acknowledged" },
          persistence: {
            state: "committed",
            references: [
              {
                reference: "client_id",
                classification: "public",
                valueId: "value-1",
                scope: "project",
              },
              {
                reference: "client_secret",
                classification: "protected",
                credentialId: "credential-1",
                scope: "project",
              },
            ],
          },
          mutationOutcome: "applied",
          reconciliation: { state: "proven_applied" },
          redispatchAllowed: false,
          reasonCodes: [],
        },
      ],
      credentialIncidents: [],
    },
    veil: {
      schemaVersion: 1,
      effectiveProfile: "balanced",
      policyDigest: "a".repeat(64),
      status: "verified",
      timeline: [],
      gaps: [],
      findings: [],
    },
    praxis: {
      contractVersion: 1,
      runtimeVersions: [],
      status: "complete",
      transactions: [],
      findings: [],
    },
    sections: {
      attempts: "complete",
      steps: "complete",
      events: "complete",
      artifacts: "complete",
      timeline: "complete",
    },
    integrity: { status: "complete", issues: [] },
    safeActions: [],
    release: { releaseId: "test", schemaFingerprint: "fingerprint" },
  };
}
