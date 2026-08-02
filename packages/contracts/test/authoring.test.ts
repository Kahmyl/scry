import { describe, expect, it } from "vitest";

import {
  createFlowDraftSchema,
  startProbeSessionSchema,
  authenticatedStateContractSchema,
} from "../src/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const context = { missionId: id, objectiveId: id, agentSessionId: id };

describe("authoring boundary contracts", () => {
  it("requires objective scope on a mutable draft", () => {
    const result = createFlowDraftSchema.safeParse({
      missionId: id,
      agentSessionId: id,
      projectId: id,
      environmentId: id,
      name: "Login",
      description: "",
      content: { objective: "Authenticate", preconditions: [], expectedOutcomes: [], prohibitedSideEffects: [] },
      plan: { name: "Login", version: 1, steps: [] },
      idempotencyKey: "draft-create-1",
    });
    expect(result.success).toBe(false);
  });

  it("requires per-session authorization and disposable-data confirmation for a calibration transaction", () => {
    const base = { ...context, environmentId: id, draftVersion: 1, level: "calibration_transaction", idempotencyKey: "probe-start-1" };
    expect(startProbeSessionSchema.safeParse({ ...base, disposableDataConfirmed: false }).success).toBe(false);
    expect(startProbeSessionSchema.safeParse({ ...base, disposableDataConfirmed: true, authorizationId: id }).success).toBe(true);
  });

  it("rejects an impossible durable-authentication signal threshold", () => {
    expect(authenticatedStateContractSchema.safeParse({
      requiredSignals: ["url_not_login"],
      optionalSignals: [],
      minimumRequiredSignals: 2,
      stabilityWindowMs: 750,
      timeoutMs: 12_000,
    }).success).toBe(false);
  });
});
