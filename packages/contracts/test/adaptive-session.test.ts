import { describe, expect, it } from "vitest";

import {
  adaptiveSessionTransitionSchema,
  advanceAdaptiveSessionSchema,
  advanceAdaptiveSessionTurnSchema,
  startAdaptiveSessionSchema,
} from "../src/index.js";

describe("adaptive session contracts", () => {
  it("accepts mission-independent session creation", () => {
    expect(
      startAdaptiveSessionSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        environmentId: "00000000-0000-4000-8000-000000000002",
        objective: "Inspect the read-only account details",
        allowedOrigins: ["https://example.test"],
        idempotencyKey: "adaptive-start-1",
      }).controlPlaneLink,
    ).toBeUndefined();
  });

  it("accepts a bounded server-owned turn and rejects duplicate operation identities", () => {
    const operation = {
      operationId: "inspect-details",
      idempotencyKey: "adaptive-operation-1",
      action: { type: "navigate" as const, url: "https://example.test/details", timeoutMs: 10_000 },
      expectedEffect: {
        type: "navigation" as const,
        url: "https://example.test/details",
        match: "exact" as const,
      },
      mode: "rehearse" as const,
      protectedInputReferences: [],
    };
    expect(
      advanceAdaptiveSessionTurnSchema.parse({
        idempotencyKey: "adaptive-turn-1",
        operations: [operation],
        budgets: { maxOperations: 1, maxDurationMs: 30_000 },
      }).operations,
    ).toHaveLength(1);
    expect(() =>
      advanceAdaptiveSessionTurnSchema.parse({
        idempotencyKey: "adaptive-turn-2",
        operations: [operation, operation],
        budgets: { maxOperations: 2, maxDurationMs: 30_000 },
      }),
    ).toThrow();
  });

  it("rejects executable or secret-bearing adaptive operation fields", () => {
    const base = {
      operationId: "inspect-details",
      idempotencyKey: "adaptive-operation-1",
      action: { type: "navigate", url: "https://example.test/details", timeoutMs: 10_000 },
      expectedEffect: {
        type: "navigation",
        url: "https://example.test/details",
        match: "exact",
      },
      mode: "rehearse",
    };
    expect(advanceAdaptiveSessionSchema.parse(base)).toMatchObject({ mode: "rehearse" });
    expect(() => advanceAdaptiveSessionSchema.parse({ ...base, javascript: "alert(1)" })).toThrow();
    expect(() =>
      advanceAdaptiveSessionSchema.parse({
        ...base,
        action: { ...base.action, candidateHandle: "stale-browser-handle" },
      }),
    ).toThrow();
  });

  it("requires optimistic session versions for transitions", () => {
    expect(() =>
      adaptiveSessionTransitionSchema.parse({
        expectedVersion: 0,
        reason: "pause",
        idempotencyKey: "adaptive-pause-1",
      }),
    ).toThrow();
  });
});
