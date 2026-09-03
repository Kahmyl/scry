import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OrchestrationService } from "../src/orchestration/orchestration.service.js";

describe("Q5 has no redundant operation approval authority", () => {
  it("refuses obsolete approval creation without writing compatibility authority", async () => {
    const transaction = vi.fn();
    const service = new OrchestrationService({ transaction } as never);
    const missionId = randomUUID(),
      operationId = "q5-canonical-reservation";
    for (const principal of [
      { kind: "service", subject: "scry-service" },
      {
        kind: "user",
        subject: "owner",
        userId: randomUUID(),
        email: "owner@example.test",
        workspaceId: randomUUID(),
        role: "owner",
      },
    ] as const)
      await expect(
        service.grantAuthorization(principal, missionId, {
          missionId,
          objectiveId: randomUUID(),
          agentSessionId: randomUUID(),
          environmentId: randomUUID(),
          kind: "protected_mutation",
          operationId,
          praxisSessionId: randomUUID(),
          reason: "Obsolete approval calls must never create dispatch authority",
          confirmedUserAuthorized: true,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          preparedOperation: {
            protectedOperationId: randomUUID(),
            preparedExecutionCapabilityId: randomUUID(),
            publicOperationId: operationId,
            contractDigest: "a".repeat(64),
          },
        }),
      ).rejects.toMatchObject({
        response: { code: "PREPARED_EXECUTION_DOES_NOT_REQUIRE_APPROVAL" },
      });
    expect(transaction).not.toHaveBeenCalled();
  });
});
