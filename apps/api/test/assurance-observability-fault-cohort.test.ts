import {
  observabilityFaultMatrix,
  qualifyObservabilityFault,
  type AssuranceEvidenceRef,
  type ObservabilityFaultCase,
} from "@scry/assurance";
import {
  buildOperationalEvent,
  type OperationalCausality,
  type OperationalComponent,
  type OperationalEventInput,
} from "@scry/observability";
import { describe, expect, it, vi } from "vitest";

import { installApiRequestObservability } from "../src/infrastructure/index.js";
import { commitExecutionReport } from "../src/runtime/report-commit.js";
import { observePraxisFailure, observeProtectedOperationResult } from "../src/runtime/index.js";

const injectedAt = "2026-08-23T12:00:00.000Z";
const availableAt = "2026-08-23T12:00:00.100Z";

type Emitted = readonly [OperationalComponent, OperationalEventInput];

function scenario(id: ObservabilityFaultCase["id"]) {
  return observabilityFaultMatrix.find((item) => item.id === id)!;
}

function proof(kind: string, ref: string): AssuranceEvidenceRef {
  return { source: "fixture", kind, ref };
}

function qualify(
  fault: ObservabilityFaultCase,
  emitted: readonly Emitted[],
  causalContext: Partial<Record<keyof OperationalCausality, string>>,
) {
  return qualifyObservabilityFault(fault, {
    caseId: fault.id,
    injectedAt,
    causalContext,
    productTruth: {
      value: fault.expectedTruth,
      evidence: [proof("product-truth", `${fault.id}:truth`)],
    },
    operationalEvents: emitted.map(([component, input], index) => ({
      event: buildOperationalEvent({
        component,
        releaseId: "qualification-release",
        schemaFingerprint: "qualification-schema",
        now: () => new Date(injectedAt),
        input,
      }),
      availableAt,
      channel: "durable_store",
      evidence: [proof("operational-event", `${fault.id}:${index}`)],
    })),
    safeAction: {
      value: fault.safeAction,
      evidence: [proof("safe-action", `${fault.id}:action`)],
    },
    telemetryFailure: {
      injected: true,
      changedProductTruth: false,
      evidence: [proof("sink-failure", `${fault.id}:sink`)],
    },
  });
}

describe("production observability adapters against the Assurance oracle", () => {
  it("qualifies the actual API validation-refusal adapter", async () => {
    let hook: Parameters<Parameters<typeof installApiRequestObservability>[0]["addHook"]>[1];
    const emitted: Emitted[] = [];
    installApiRequestObservability(
      {
        addHook: (_name, installed) => {
          hook = installed;
        },
      },
      {
        emit: vi.fn(async (component, input) => {
          emitted.push([component, input]);
        }),
      },
    );

    await hook!(
      {
        method: "POST",
        headers: { "x-correlation-id": "correlation-api" },
        routeOptions: { url: "/api/missions" },
      },
      { statusCode: 400 },
      JSON.stringify({ code: "API_INPUT_VALIDATION_FAILED", private: "not-observed" }),
    );

    expect(
      qualify(scenario("invalid_api_input"), emitted, { correlationId: "correlation-api" }),
    ).toMatchObject({
      status: "pass",
      points: 8,
    });
  });

  it("qualifies the actual Praxis stale-reference adapter", async () => {
    const emitted: Emitted[] = [];
    const context = {
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      agentSessionId: "agent-1",
      runId: "run-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
    };
    await observePraxisFailure(
      {
        emit: async (component: OperationalComponent, input: OperationalEventInput) =>
          void emitted.push([component, input]),
      } as never,
      context,
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

    expect(
      qualify(scenario("stale_exact_reference"), emitted, {
        ...context,
        operationId: "operation-1",
      }),
    ).toMatchObject({ status: "pass", points: 8 });
  });

  it.each([
    {
      id: "owned_request_timeout" as const,
      reasonCode: "PROTECTED_RESPONSE_SETTLEMENT_TIMEOUT",
      failurePhase: "mutation_reconciliation",
      reconciliation: "unknown",
    },
    {
      id: "response_observed_persistence_failure" as const,
      reasonCode: "ATOMIC_OUTPUT_PERSISTENCE_FAILED",
      failurePhase: "persistence",
      reconciliation: "unknown",
    },
    {
      id: "reconciliation_ambiguity" as const,
      reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
      failurePhase: "mutation_reconciliation",
      reconciliation: "unknown",
    },
  ])("qualifies the actual protected-operation adapter for $id", async (input) => {
    const emitted: Emitted[] = [];
    const context = {
      ownerKind: "run" as const,
      ownerId: "run-1",
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      agentSessionId: "agent-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
    };
    await observeProtectedOperationResult(
      {
        emit: async (component: OperationalComponent, event: OperationalEventInput) =>
          void emitted.push([component, event]),
      } as never,
      context,
      "operation-1",
      {
        status: "outcome_unknown",
        reasonCode: input.reasonCode,
        mutation: { dispatch: "started", outcome: "unknown" },
        reconciliation: input.reconciliation,
        failurePhase: input.failurePhase,
        retryClass: "retry_requires_reconciliation",
        safeActions: ["manual_reconciliation", "abort"],
      } as never,
      "protected-1",
    );

    expect(
      qualify(scenario(input.id), emitted, {
        ...context,
        runId: context.ownerId,
        operationId: "operation-1",
        protectedOperationId: "protected-1",
      }),
    ).toMatchObject({ status: "pass", points: 8 });
  });

  it.each([
    { id: "database_failure" as const, reasonCode: "DATABASE_WRITE_FAILED" },
    { id: "report_finalization_failure" as const, reasonCode: "REPORT_FINALIZATION_FAILED" },
  ])("qualifies actual report transaction failure events for $id", async ({ id, reasonCode }) => {
    const emitted: Emitted[] = [];
    const causalContext = {
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      agentSessionId: "agent-1",
      runId: "run-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
    };
    await expect(
      commitExecutionReport(
        {
          executions: {
            observationTransaction: vi.fn(async () => {
              throw new Error(reasonCode);
            }),
          } as never,
          artifactRoot: "/tmp/scry-observability-qualification",
          artifactRetentionMs: 60_000,
          artifactStore: { delete: vi.fn(), exists: vi.fn() } as never,
          artifactStoreRemote: false,
          operationalEvents: {
            emit: async (component, input) => void emitted.push([component, input]),
          },
          causality: causalContext,
        },
        {
          runId: "run-1",
          state: "passed",
          artifacts: [],
          steps: [],
          artifactTimeline: [],
        } as never,
        "/tmp/scry-observability-qualification/run-1",
        "attempt-1",
        "claim-1",
      ),
    ).rejects.toThrow(reasonCode);

    expect(qualify(scenario(id), emitted, causalContext)).toMatchObject({
      status: "pass",
      points: 8,
    });
  });

  it("qualifies the actual artifact-store failure boundary", async () => {
    const emitted: Emitted[] = [];
    const causalContext = {
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      agentSessionId: "agent-1",
      runId: "run-1",
      attemptId: "attempt-1",
      correlationId: "correlation-1",
    };
    const artifactStoreFailure = new Error("ARTIFACT_STORE_WRITE_FAILED");
    await expect(
      commitExecutionReport(
        {
          executions: {
            observationTransaction: vi.fn(async (callback) =>
              callback({ recordCaptureEpochs: vi.fn() }),
            ),
          } as never,
          artifactRoot: "/tmp/scry-observability-qualification",
          artifactRetentionMs: 60_000,
          artifactStore: {
            quarantine: vi.fn(async () => {
              throw artifactStoreFailure;
            }),
            delete: vi.fn(),
            exists: vi.fn(),
          } as never,
          artifactStoreRemote: false,
          operationalEvents: {
            emit: async (component, input) => void emitted.push([component, input]),
          },
          causality: causalContext,
        },
        {
          runId: "run-1",
          state: "passed",
          artifacts: [{ id: "artifact-1", kind: "screenshot", availability: "quarantined" }],
          steps: [],
          artifactTimeline: [],
        } as never,
        "/tmp/scry-observability-qualification/run-1",
        "attempt-1",
        "claim-1",
      ),
    ).rejects.toBe(artifactStoreFailure);

    expect(qualify(scenario("artifact_store_failure"), emitted, causalContext)).toMatchObject({
      status: "pass",
      points: 8,
    });
  });
});
