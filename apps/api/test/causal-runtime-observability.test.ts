import { describe, expect, it, vi } from "vitest";

import { observePraxisFailure, observeProtectedOperationResult } from "../src/runtime/index.js";
import { commitExecutionReport } from "../src/runtime/report-commit.js";

describe("representative causal runtime observability", () => {
  it("correlates a Praxis stale-authority failure across Mission, Run, and Attempt", async () => {
    const events = { emit: vi.fn(async () => undefined) };
    await observePraxisFailure(
      events as never,
      {
        projectId: "project-1",
        missionId: "mission-1",
        objectiveId: "objective-1",
        agentSessionId: "agent-1",
        runId: "run-1",
        attemptId: "attempt-1",
        correlationId: "correlation-1",
      },
      {
        status: "failed",
        code: "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
        operationId: "operation-1",
        phase: "failed",
        provenance: "praxis",
        mutationOutcome: "not_applied",
        retry: "requires_reobservation",
        timing: { totalMs: 17 },
      } as never,
    );

    expect(events.emit).toHaveBeenCalledWith(
      "praxis",
      expect.objectContaining({
        name: "praxis.action_failed",
        classification: "stale_authority",
        reasonCode: "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
        causality: {
          projectId: "project-1",
          missionId: "mission-1",
          objectiveId: "objective-1",
          agentSessionId: "agent-1",
          runId: "run-1",
          attemptId: "attempt-1",
          operationId: "operation-1",
          correlationId: "correlation-1",
        },
      }),
    );
  });

  it("preserves unknown mutation truth and emits only reconciliation-safe facts", async () => {
    const events = { emit: vi.fn(async () => undefined) };
    const result = {
      status: "outcome_unknown",
      reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
      mutation: { dispatch: "started", outcome: "unknown" },
      reconciliation: "unknown",
      failurePhase: "mutation_reconciliation",
      retryClass: "retry_requires_reconciliation",
      safeActions: ["manual_reconciliation", "abort"],
    };

    await observeProtectedOperationResult(
      events as never,
      {
        ownerKind: "run",
        ownerId: "run-1",
        projectId: "project-1",
        missionId: "mission-1",
        objectiveId: "objective-1",
        agentSessionId: "agent-1",
        attemptId: "attempt-1",
        correlationId: "correlation-1",
      },
      "protected-operation-1",
      result as never,
    );

    expect(result.mutation.outcome).toBe("unknown");
    expect(events.emit).toHaveBeenCalledWith("runtime", {
      name: "protected_operation.reconciliation_required",
      classification: "reconciliation_unknown",
      reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
      outcome: "reconciliation_required",
      causality: {
        projectId: "project-1",
        missionId: "mission-1",
        objectiveId: "objective-1",
        agentSessionId: "agent-1",
        runId: "run-1",
        attemptId: "attempt-1",
        operationId: "protected-operation-1",
        protectedOperationId: "protected-operation-1",
        correlationId: "correlation-1",
      },
      details: {
        mutationDispatch: "started",
        mutationOutcome: "unknown",
        reconciliation: "unknown",
        failurePhase: "mutation_reconciliation",
        retryClass: "retry_requires_reconciliation",
        safeActions: ["manual_reconciliation", "abort"],
      },
    });
  });

  it("emits persistence and report-finalization failures without changing the failure", async () => {
    const events = { emit: vi.fn(async () => undefined) };
    const original = new Error("DATABASE_WRITE_FAILED");
    const executions = {
      observationTransaction: vi.fn(async () => {
        throw original;
      }),
    };

    await expect(
      commitExecutionReport(
        {
          executions: executions as never,
          artifactRoot: "/tmp/scry-artifacts",
          artifactRetentionMs: 60_000,
          artifactStore: { delete: vi.fn(), exists: vi.fn() } as never,
          artifactStoreRemote: false,
          operationalEvents: events,
          causality: { missionId: "mission-1", objectiveId: "objective-1" },
        },
        {
          runId: "run-1",
          state: "passed",
          artifacts: [],
          steps: [],
          artifactTimeline: [],
        } as never,
        "/tmp/scry-artifacts/run-1",
        "attempt-1",
        "claim-1",
      ),
    ).rejects.toBe(original);

    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenNthCalledWith(
      1,
      "runtime",
      expect.objectContaining({
        name: "report.finalization_failed",
        classification: "persistence",
        reasonCode: "DATABASE_WRITE_FAILED",
        causality: {
          missionId: "mission-1",
          objectiveId: "objective-1",
          runId: "run-1",
          attemptId: "attempt-1",
        },
      }),
    );
    expect(events.emit).toHaveBeenNthCalledWith(
      2,
      "runtime",
      expect.objectContaining({
        name: "persistence.write_failed",
        reasonCode: "DATABASE_WRITE_FAILED",
      }),
    );
  });
});
