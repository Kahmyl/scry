import { randomUUID } from "node:crypto";

import type { MissionAuthoringIntent } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";

type AuthorizationKind =
  "live_read" | "live_mutation" | "protected_mutation" | "authentication_calibration";

function createHarness(_historicalApprovalKind: AuthorizationKind) {
  const ids = {
    sessionId: randomUUID(),
    missionId: randomUUID(),
    objectiveId: randomUUID(),
    flowDraftId: randomUUID(),
    environmentId: randomUUID(),
    authorizationId: randomUUID(),
  };

  const query = vi.fn(
    async (
      text: string,
      values: unknown[] = [],
    ): Promise<{
      rowCount: number;
      rows: unknown[];
    }> => {
      if (text.includes("FROM adaptive_sessions WHERE id=$1")) {
        return {
          rowCount: 1,
          rows: [
            {
              environmentId: ids.environmentId,
              missionId: ids.missionId,
              activeObjectiveId: ids.objectiveId,
              protectedAllowlist: [],
              allowedOrigins: ["https://preview.vitract.com"],
            },
          ],
        };
      }

      if (text.includes("FROM protected_operations WHERE owner_kind='authoring_session'")) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      if (text.includes("FROM mission_authorizations"))
        throw new Error("LEGACY_APPROVAL_QUERY_FORBIDDEN");

      throw new Error(`Unexpected query in authorization binding regression:\n${text}`);
    },
  );

  const repository = new AdaptiveSessionRepository({
    query,
  } as never);

  const intent: MissionAuthoringIntent = {
    intentId: "r07-save-live-mutation-auth-binding",
    objectiveId: ids.objectiveId,
    flowDraftId: ids.flowDraftId,
    action: {
      kind: "activate",
      target: {
        concept: "Save",
        reference: `context-control-${"a".repeat(32)}`,
        exact: true,
      },
      semanticEffect: "resource_mutation",
    },
    expectedEffect: {
      kind: "none",
    },
    constraints: {
      timeoutMs: 30_000,
      allowNewPage: false,
      allowNonExact: false,
    },
    authorization: {
      kind: "live_mutation",
      authorizationId: ids.authorizationId,
    },
    protectedInputReferences: [],
  };

  return {
    ids,
    intent,
    query,
    repository,
  };
}

describe("Legacy approvals cannot replace prepared execution", () => {
  it("rejects cross-kind authorization reuse for live mutation", async () => {
    const { ids, intent, repository } = createHarness("authentication_calibration");

    await expect(
      repository.validateIntentAdmission({
        sessionId: ids.sessionId,
        intent,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "PREPARED_EXECUTION_REQUIRED",
      },
    });
  });

  it("rejects even an approved authorization of the exact declared kind", async () => {
    const { ids, intent, repository } = createHarness("live_mutation");

    await expect(
      repository.validateIntentAdmission({
        sessionId: ids.sessionId,
        intent,
      }),
    ).rejects.toMatchObject({ response: { code: "PREPARED_EXECUTION_REQUIRED" } });
  });

  it("rejects protected authorization bound to a different intent", async () => {
    const { ids, intent, repository } = createHarness("protected_mutation");
    intent.authorization.kind = "protected_mutation";
    intent.intentId = "different-protected-intent";

    await expect(
      repository.validateIntentAdmission({ sessionId: ids.sessionId, intent }),
    ).rejects.toMatchObject({
      response: { code: "PREPARED_EXECUTION_REQUIRED" },
    });
  });

  it("rejects protected authorization bound to a different Praxis session", async () => {
    const { ids, intent, repository } = createHarness("protected_mutation");
    intent.authorization.kind = "protected_mutation";

    await expect(
      repository.validateIntentAdmission({ sessionId: randomUUID(), intent }),
    ).rejects.toMatchObject({
      response: { code: "PREPARED_EXECUTION_REQUIRED" },
    });
  });
});
