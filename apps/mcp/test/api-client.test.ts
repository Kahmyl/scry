import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient, ScryApiError } from "../src/api-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("ScryApiClient", () => {
  it("calls the configured Scry API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "run-1", state: "queued" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient("http://scry.test/api");
    await expect(client.post("/runs/run-1/cancel")).resolves.toEqual({
      id: "run-1",
      state: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/api/runs/run-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns stable artifact URLs and useful errors", async () => {
    const client = new ScryApiClient("http://scry.test/api");
    expect(client.artifactUrl("artifact id")).toBe("http://scry.test/api/artifacts/artifact%20id");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "Run not found" }), { status: 404 }),
        ),
    );
    await expect(client.get("/runs/missing")).rejects.toThrow(
      'Scry API request rejected: {"code":"Run not found"',
    );
  });

  it("preserves typed API rejection codes and safe actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: {
              code: "CERTIFICATION_RUN_REQUIRED",
              safeActions: ["compile_and_certify_flow"],
              capability: "execution_ready_compilation",
              missingCount: 1,
              mutationOutcome: "not_applied",
              retry: "safe_after_prerequisite",
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = await new ScryApiClient("http://scry.test/api")
      .post("/flow-drafts/draft/publish")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ScryApiError);
    expect(error).toMatchObject({
      code: "CERTIFICATION_RUN_REQUIRED",
      status: 409,
      safeActions: ["compile_and_certify_flow"],
      context: {
        capability: "execution_ready_compilation",
        missingCount: 1,
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      },
    });
    expect(String((error as Error).message)).toContain('"mutationOutcome":"not_applied"');
  });

  it("does not project arbitrary or validation-derived fields into external rejection context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: {
              code: "SAFE_REJECTION",
              safeActions: ["get_flow_authoring"],
              state: "recovery_required",
              secret: "must-not-escape",
              issues: [{ path: ["value"], input: "must-not-escape" }],
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = (await new ScryApiClient("http://scry.test/api")
      .get("/fixture")
      .catch((cause: unknown) => cause)) as ScryApiError;
    expect(error.context).toEqual({ state: "recovery_required" });
    expect(JSON.stringify(error)).not.toContain("must-not-escape");
    expect(error.message).not.toContain("must-not-escape");
  });

  it("projects only bounded factual origins for a pre-write trust recovery mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: {
              code: "TRUST_RECOVERY_ORIGIN_MISMATCH",
              safeActions: ["get_flow_authoring", "recover_trusted_script_origins"],
              disclosedOrigins: ["https://scripts.example.test"],
              mutationOutcome: "not_applied",
              retry: "safe_after_prerequisite",
              secret: "must-not-escape",
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const error = (await new ScryApiClient("http://scry.test/api")
      .post("/fixture")
      .catch((cause: unknown) => cause)) as ScryApiError;
    expect(error).toMatchObject({
      safeActions: ["get_flow_authoring", "recover_trusted_script_origins"],
      context: {
        disclosedOrigins: ["https://scripts.example.test"],
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      },
    });
    expect(error.message).not.toContain("must-not-escape");
  });

  it("preserves the bounded factual recovery binding for stale authoring recovery", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: {
              code: "MISSION_AUTHORING_RECOVERY_STALE",
              safeActions: ["get_flow_authoring"],
              currentTurnState: "decision_required",
              refreshedDecisionBoundary: {
                type: "environment_unavailable",
                reasonCode: "ADAPTIVE_RUNTIME_UNAVAILABLE",
                safeActions: ["get_flow_authoring", "advance_flow_authoring"],
                authoringRecovery: {
                  sessionId: id,
                  missionId: id,
                  objectiveId: id,
                  flowDraftId: id,
                  environmentId: id,
                  failedOperationId: "failed-operation",
                  sourceTurnId: id,
                  environmentResourceExists: true,
                  executionReadiness: "runtime_reprovision_required",
                  preservesCurrentFlow: true,
                  recoveryTool: "advance_flow_authoring",
                  recoveryKind: "intents",
                  requiresPendingTurn: false,
                  requiresFreshIdempotencyKey: true,
                },
              },
            },
          }),
          { status: 409 },
        ),
      ),
    );
    const error = (await new ScryApiClient("http://scry.test/api")
      .post("/fixture")
      .catch((cause: unknown) => cause)) as ScryApiError;
    expect(error.context).toMatchObject({
      refreshedDecisionBoundary: {
        authoringRecovery: { sessionId: id, recoveryKind: "intents" },
      },
    });
  });

  it("updates API resources with PATCH", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "environment-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient("http://scry.test/api");
    await expect(client.patch("/environments/environment-1", { secretRefs: [] })).resolves.toEqual({
      id: "environment-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://scry.test/api/environments/environment-1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("fails closed when the API does not advertise the cutoff Praxis versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            releaseId: "development",
            schemaFingerprint: "development-baseline",
            praxis: {
              contractVersion: 1,
              runtimeVersion: "0",
              scoringPolicyVersion: 1,
              cutoff: true,
            },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(new ScryApiClient("http://scry.test/api").requireCurrentRelease()).rejects.toThrow(
      "SCRY_PRAXIS_VERSION_MISMATCH",
    );
  });

  it("retrieves authenticated artifacts and uses the public artifact URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("evidence", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScryApiClient(
      "http://api.internal/api",
      "token",
      "https://scry.example/api",
    );
    expect(client.artifactUrl("artifact id")).toBe(
      "https://scry.example/api/artifacts/artifact%20id",
    );
    await expect(client.getArtifact("artifact id")).resolves.toMatchObject({
      contentType: "text/plain",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.internal/api/artifacts/artifact%20id",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});
