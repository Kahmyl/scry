import { describe, expect, it } from "vitest";
import { createExecutionPlanSchema, orchestrationStateSchema } from "../src/index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("Mission orchestration contracts", () => {
  it("requires immutable bindings for automated objectives", () => {
    expect(() =>
      createExecutionPlanSchema.parse({
        missionId: id(1),
        agentSessionId: id(2),
        idempotencyKey: "plan-key-1",
        bindings: [{ objectiveId: id(3), mode: "automatic" }],
      }),
    ).toThrow(/immutable Flow revision/);
  });
  it("allows explicitly manual objectives without synthetic execution", () => {
    expect(
      createExecutionPlanSchema.parse({
        missionId: id(1),
        agentSessionId: id(2),
        idempotencyKey: "plan-key-2",
        bindings: [{ objectiveId: id(3), mode: "manual" }],
      }).bindings[0]?.mode,
    ).toBe("manual");
  });
  it("exposes every durable orchestration state", () => {
    for (const state of [
      "unscheduled",
      "ready",
      "queued",
      "running",
      "awaiting_evidence",
      "passed",
      "failed",
      "blocked",
      "awaiting_authorization",
      "cancelled",
    ])
      expect(orchestrationStateSchema.parse(state)).toBe(state);
  });
});
