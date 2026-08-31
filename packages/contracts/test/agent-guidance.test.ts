import { describe, expect, it } from "vitest";

import { grantMissionAuthorizationSchema, publicApiRejectionSchema } from "../src/index.js";

const id = (value: string) =>
  `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;

describe("agent-facing guidance contracts", () => {
  it("keeps UNKNOWN mutation truth fenced from retry-safe semantics", () => {
    expect(
      publicApiRejectionSchema.safeParse({
        code: "MUTATION_OUTCOME_UNKNOWN",
        status: 409,
        rejectionClass: "reconciliation_unknown",
        reason: "mutation outcome unknown",
        exactIds: { missionId: id("1"), operationId: "operation-1" },
        resolution: "reconcile_unknown",
        safeActions: ["reconcile_unknown_operation", "do_not_retry"],
        nextActions: ["reconcile_unknown_operation"],
        retry: "reconciliation_required",
        appliedState: "unknown",
      }).success,
    ).toBe(true);
    expect(
      publicApiRejectionSchema.safeParse({
        code: "MUTATION_OUTCOME_UNKNOWN",
        status: 409,
        rejectionClass: "reconciliation_unknown",
        reason: "mutation outcome unknown",
        exactIds: {},
        resolution: "reconcile_unknown",
        safeActions: [],
        nextActions: [],
        retry: "safe_to_retry",
        appliedState: "unknown",
      }).success,
    ).toBe(false);
  });

  it("structurally requires exact operation and Praxis bindings for protected authorization", () => {
    const common = {
      missionId: id("1"),
      agentSessionId: id("2"),
      objectiveId: id("3"),
      environmentId: id("4"),
      reason: "User explicitly authorized the exact protected operation.",
      confirmedUserAuthorized: true as const,
    };
    expect(
      grantMissionAuthorizationSchema.safeParse({ ...common, kind: "protected_mutation" }).success,
    ).toBe(false);
    expect(
      grantMissionAuthorizationSchema.safeParse({
        ...common,
        kind: "protected_mutation",
        operationId: "operation-1",
        praxisSessionId: id("5"),
        expiresAt: "2099-01-01T00:00:00.000Z",
        preparedOperation: {
          protectedOperationId: id("6"),
          preparedExecutionCapabilityId: id("7"),
          publicOperationId: "operation-1",
          contractDigest: "a".repeat(64),
        },
      }).success,
    ).toBe(true);
  });
});
