import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRejection, ScryApiClient, ScryApiError } from "../src/api-client.js";

describe("ScryApiClient validation rejection projection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects truthful provider/model provenance without a Codex fallback", () => {
    expect(
      new ScryApiClient("http://scry.test/api", undefined, undefined, {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        externalRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).missionProvenance(),
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      externalRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(
      new ScryApiClient("http://scry.test/api", undefined, undefined, {
        provider: "synthetic-provider",
      }).missionProvenance(),
    ).toEqual({ provider: "synthetic-provider" });
    expect(new ScryApiClient("http://scry.test/api").missionProvenance()).toEqual({
      provider: "unknown",
    });
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
      rejectionClass: "invalid_input",
      reason: "scry api request validation failed",
      exactIds: {},
      resolution: "correct_input",
      appliedState: "not_applied",
      retry: "unspecified",
      safeActions: [],
      nextActions: [],
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

  it.each([
    ["REQUEST_INVALID", 400, "not_applied", "invalid_input", "correct_input"],
    ["FLOW_REVISION_NOT_FOUND", 404, "not_applied", "invalid_input", "correct_input"],
    ["CONTEXT_REFERENCE_STALE", 409, "not_applied", "stale_authority", "refresh_authority"],
    [
      "PROTECTED_AUTHORIZATION_REQUIRED",
      409,
      "not_applied",
      "policy_authorization",
      "obtain_authorization",
    ],
    ["PROVIDER_RESPONSE_FAILED", 409, "not_applied", "application_provider", "inspect_application"],
    [
      "PERSISTENCE_FAILED",
      500,
      "not_applied",
      "infrastructure_persistence",
      "restore_infrastructure",
    ],
    ["MUTATION_OUTCOME_UNKNOWN", 409, "unknown", "reconciliation_unknown", "reconcile_unknown"],
  ] as const)(
    "classifies %s as stable public class %s",
    (code, status, mutationOutcome, rejectionClass, resolution) => {
      const rejection = apiRejection(
        new ScryApiError(code, status, ["get_run", "reconcile_unknown_operation"], {
          missionId: "11111111-1111-4111-8111-111111111111",
          runId: "22222222-2222-4222-8222-222222222222",
          operationId: "operation-1",
          mutationOutcome,
        }),
      );
      expect(rejection).toMatchObject({
        rejectionClass,
        resolution,
        exactIds: {
          missionId: "11111111-1111-4111-8111-111111111111",
          runId: "22222222-2222-4222-8222-222222222222",
          operationId: "operation-1",
        },
      });
      if (mutationOutcome === "unknown") {
        expect(rejection.retry).toBe("reconciliation_required");
        expect(rejection.nextActions).toEqual(["get_run", "reconcile_unknown_operation"]);
      }
    },
  );

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
                truncated: false,
                totalBlockerCount: 1,
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

  it("propagates only factual transport and causal identities", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", request);
    const client = new ScryApiClient(
      "http://scry.test/api",
      "service-token",
      "http://scry.test/api",
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        externalRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        experimentId: "experiment-1",
        correlationId: "correlation-1",
      },
    );
    client.setMcpSessionId("mcp-session-1");

    await client.post("/projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/runs", {
      missionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      objectiveId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agentSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      praxisSessionId: "11111111-1111-4111-8111-111111111111",
      protectedValue: "must-not-be-a-header",
    });

    const headers = request.mock.calls[0]![1].headers as Headers;
    expect(Object.fromEntries(headers.entries())).toMatchObject({
      "x-correlation-id": "correlation-1",
      "x-scry-project-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "x-scry-mission-id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "x-scry-objective-id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "x-scry-agent-session-id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "x-scry-mcp-session-id": "mcp-session-1",
      "x-scry-praxis-session-id": "11111111-1111-4111-8111-111111111111",
    });
    expect(JSON.stringify(Object.fromEntries(headers.entries()))).not.toContain(
      "must-not-be-a-header",
    );
  });
});
