import { describe, expect, it, vi } from "vitest";

import {
  OperationalEventEmitter,
  buildOperationalEvent,
  type OperationalEvent,
} from "../src/index.js";

describe("canonical operational events", () => {
  it("preserves stable causal, release, transition, duration, and reason facts", () => {
    const event = buildOperationalEvent({
      component: "worker",
      releaseId: "release-1",
      schemaFingerprint: "schema-1",
      now: () => new Date("2026-08-23T10:00:00.000Z"),
      input: {
        name: "worker.execution_failed",
        classification: "infrastructure",
        reasonCode: "WORKER_PROCESS_LOST",
        outcome: "failed",
        causality: {
          projectId: "project-1",
          missionId: "mission-1",
          objectiveId: "objective-1",
          agentSessionId: "agent-1",
          runId: "run-1",
          attemptId: "attempt-1",
          correlationId: "correlation-1",
        },
        transition: { from: "running", to: "failed" },
        durationMs: 12.34567,
      },
    });

    expect(event).toMatchObject({
      schemaVersion: 1,
      name: "worker.execution_failed",
      component: "worker",
      occurredAt: "2026-08-23T10:00:00.000Z",
      critical: true,
      classification: "infrastructure",
      reasonCode: "WORKER_PROCESS_LOST",
      releaseId: "release-1",
      schemaFingerprint: "schema-1",
      transition: { from: "running", to: "failed" },
      durationMs: 12.346,
      causality: {
        projectId: "project-1",
        missionId: "mission-1",
        objectiveId: "objective-1",
        agentSessionId: "agent-1",
        runId: "run-1",
        attemptId: "attempt-1",
        correlationId: "correlation-1",
      },
    });
  });

  it("redacts protected material at emission without losing safe diagnostics", () => {
    const canary = "never-emit-this-protected-value";
    const event = buildOperationalEvent({
      component: "runtime",
      input: {
        name: "protected_operation.reconciliation_required",
        classification: "reconciliation_unknown",
        reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
        outcome: "reconciliation_required",
        causality: { operationId: "operation-1" },
        details: {
          mutationOutcome: "unknown",
          protectedValue: canary,
          authorization: `Bearer ${canary}`,
          nested: { cookie: canary, phase: "reconciliation" },
        },
      },
    });

    expect(JSON.stringify(event)).not.toContain(canary);
    expect(event.details).toMatchObject({
      mutationOutcome: "unknown",
      protectedValue: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: { cookie: "[REDACTED]", phase: "reconciliation" },
    });
  });

  it("does not sample critical events and cannot throw into product truth", async () => {
    const events: OperationalEvent[] = [];
    const emitter = new OperationalEventEmitter({
      component: "praxis",
      sink: (event) => {
        events.push(event);
      },
    });
    const input = {
      name: "praxis.action_failed" as const,
      classification: "stale_authority" as const,
      reasonCode: "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
      outcome: "failed" as const,
    };

    await emitter.emit(input);
    await emitter.emit(input);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.critical)).toBe(true);

    const broken = new OperationalEventEmitter({
      component: "runtime",
      sink: vi.fn(() => {
        throw new Error("telemetry unavailable");
      }),
    });
    await expect(broken.emit(input)).resolves.toBeUndefined();
  });
});
