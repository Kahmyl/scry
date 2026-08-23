import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRejection, ScryApiClient, ScryApiError } from "../src/api-client.js";

describe("ScryApiClient validation rejection projection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies ordinary validation message arrays without exposing raw validation text", async () => {
    const rawValidationMessage = 'Unrecognized key: "externalResourcePresentationAuthorities"';

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: [rawValidationMessage],
            error: "Bad Request",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    const client = new ScryApiClient("http://scry.test/api");

    let caught: unknown;

    try {
      await client.patch("/environments/example", { intentionallyInvalid: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ScryApiError);

    const rejection = apiRejection(caught as ScryApiError);

    expect(rejection).toEqual({
      code: "SCRY_API_REQUEST_VALIDATION_FAILED",
      status: 400,
      appliedState: "not_applied",
      retry: "unspecified",
      safeActions: [],
      context: {
        validationIssueCount: 1,
      },
    });

    expect(JSON.stringify(rejection)).not.toContain(rawValidationMessage);

    expect(JSON.stringify(rejection)).not.toContain("externalResourcePresentationAuthorities");
  });

  it("preserves a structured API code instead of replacing it with validation classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: {
              code: "MISSION_CONTEXT_INVALID",
              safeActions: ["resume_mission"],
              mutationOutcome: "not_applied",
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      ),
    );

    const client = new ScryApiClient("http://scry.test/api");

    let caught: unknown;

    try {
      await client.patch("/environments/example", {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ScryApiError);

    expect(apiRejection(caught as ScryApiError)).toMatchObject({
      code: "MISSION_CONTEXT_INVALID",
      status: 400,
      appliedState: "not_applied",
      safeActions: ["resume_mission"],
    });
  });

  it("preserves the canonical Mission readiness blocker facts and drops adjacent unsafe data", async () => {
    const missionId = "11111111-1111-4111-8111-111111111111";
    const objectiveId = "22222222-2222-4222-8222-222222222222";
    const protectedOperationId = "33333333-3333-4333-8333-333333333333";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: {
              code: "MUTATION_RECONCILIATION_REQUIRED",
              safeActions: ["get_mission", "reconcile_unknown_operation", "do_not_retry"],
              mutationOutcome: "unknown",
              retry: "reconciliation_required",
              readiness: {
                ready: false,
                missionId,
                blockers: [
                  {
                    code: "MUTATION_RECONCILIATION_REQUIRED",
                    missionId,
                    objectiveId,
                    protectedOperationId,
                    operationId: "protected-mutation",
                    state: "unknown",
                    reasonCode: "MUTATION_OUTCOME_UNKNOWN",
                    resolution: "mutation_reconciliation_required",
                    safeActions: ["get_mission", "reconcile_unknown_operation", "do_not_retry"],
                    nextActions: ["reconcile_unknown_operation"],
                  },
                ],
              },
              protectedValue: "must-not-escape",
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = (await new ScryApiClient("http://scry.test/api")
      .post(`/missions/${missionId}/reports`)
      .catch((cause: unknown) => cause)) as ScryApiError;

    expect(apiRejection(error)).toMatchObject({
      code: "MUTATION_RECONCILIATION_REQUIRED",
      appliedState: "unknown",
      retry: "reconciliation_required",
      context: {
        readiness: {
          ready: false,
          missionId,
          blockers: [
            expect.objectContaining({
              objectiveId,
              protectedOperationId,
              operationId: "protected-mutation",
              resolution: "mutation_reconciliation_required",
            }),
          ],
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain("must-not-escape");
  });
});
