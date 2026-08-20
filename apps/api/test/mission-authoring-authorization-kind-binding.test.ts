import { randomUUID } from "node:crypto";

import type { MissionAuthoringIntent } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";

type AuthorizationKind =
  "live_read" | "live_mutation" | "protected_mutation" | "authentication_calibration";

type AuthorizationRow = {
  id: string;
  missionId: string;
  objectiveId: string;
  environmentId: string;
  kind: AuthorizationKind;
  status: "approved" | "revoked";
  expired: boolean;
  operationId: string;
  praxisSessionId: string;
};

function createHarness(authorizationKind: AuthorizationKind) {
  const ids = {
    sessionId: randomUUID(),
    missionId: randomUUID(),
    objectiveId: randomUUID(),
    flowDraftId: randomUUID(),
    environmentId: randomUUID(),
    authorizationId: randomUUID(),
  };

  const authorization: AuthorizationRow = {
    id: ids.authorizationId,
    missionId: ids.missionId,
    objectiveId: ids.objectiveId,
    environmentId: ids.environmentId,
    kind: authorizationKind,
    status: "approved",
    expired: false,
    operationId: "r07-save-live-mutation-auth-binding",
    praxisSessionId: ids.sessionId,
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

      if (text.includes("FROM mission_authorizations WHERE id=$1")) {
        const [
          authorizationId,
          missionId,
          objectiveId,
          environmentId,
          requiredKind,
          operationId,
          praxisSessionId,
        ] = values;

        let matches =
          authorization.id === authorizationId &&
          authorization.missionId === missionId &&
          authorization.objectiveId === objectiveId &&
          authorization.environmentId === environmentId &&
          authorization.status === "approved" &&
          !authorization.expired;

        /*
         * Model exactly what the SQL proves.
         *
         * Before the remediation there is no kind=$5
         * predicate, so a cross-kind authorization matches.
         *
         * After remediation the same fake database applies
         * the new predicate and exposes the intended behavior.
         */
        if (/(?:^|\s)kind\s*=\s*\$5(?:\s|$)/m.test(text)) {
          matches = matches && authorization.kind === requiredKind;
        }
        if (text.includes("operation_id=$6 AND praxis_session_id=$7")) {
          matches =
            matches &&
            (requiredKind !== "protected_mutation" ||
              (authorization.operationId === operationId &&
                authorization.praxisSessionId === praxisSessionId));
        }

        return {
          rowCount: matches ? 1 : 0,
          rows: matches ? [{ authorized: true }] : [],
        };
      }

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

describe("Mission authoring authorization kind binding", () => {
  it("rejects cross-kind authorization reuse for live mutation", async () => {
    const { ids, intent, repository } = createHarness("authentication_calibration");

    await expect(
      repository.validateIntentAdmission({
        sessionId: ids.sessionId,
        intent,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_AUTHORIZATION_INVALID",
      },
    });
  });

  it("accepts an approved authorization of the exact declared kind", async () => {
    const { ids, intent, repository } = createHarness("live_mutation");

    await expect(
      repository.validateIntentAdmission({
        sessionId: ids.sessionId,
        intent,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects protected authorization bound to a different intent", async () => {
    const { ids, intent, repository } = createHarness("protected_mutation");
    intent.authorization.kind = "protected_mutation";
    intent.intentId = "different-protected-intent";

    await expect(
      repository.validateIntentAdmission({ sessionId: ids.sessionId, intent }),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_AUTHORIZATION_INVALID" },
    });
  });

  it("rejects protected authorization bound to a different Praxis session", async () => {
    const { ids, intent, repository } = createHarness("protected_mutation");
    intent.authorization.kind = "protected_mutation";

    await expect(
      repository.validateIntentAdmission({ sessionId: randomUUID(), intent }),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_AUTHORIZATION_INVALID" },
    });
  });
});
