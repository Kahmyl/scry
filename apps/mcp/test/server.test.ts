import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const context = {
  missionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  objectiveId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  agentSessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
const admittedCapabilities = {
  releaseId: process.env.SCRY_RELEASE_ID ?? "development",
  schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
  supportedActions: [],
  evidenceChannels: [],
  artifactCapabilities: [],
  collectorCapabilities: [],
  praxis: {
    contractVersion: 1,
    runtimeVersion: "1",
    scoringPolicyVersion: 1,
    cutoff: true,
    evidenceChannels: [],
    strategies: [],
    hardBoundaries: [],
  },
};

describe("current Scry MCP surface", () => {
  it("returns the shared safe Mission projection unchanged for get and resume", async () => {
    const safeMission = {
      id: context.missionId,
      status: "running",
      resumePointer: { objectiveId: context.objectiveId, recommendedAction: "review_failure", explanation: "Review safe reason" },
      objectives: [{ id: context.objectiveId, title: "Safe objective", status: "running" }],
      authoring: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", state: "editing",
        probes: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "completed" }],
        compilations: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "failed" }] }],
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/capabilities")
        ? admittedCapabilities
        : init?.method === "POST"
          ? { missionId: context.missionId, agentSessionId: context.agentSessionId, status: "active" }
          : safeMission;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    const { client, server } = await connected();
    await client.callTool({ name: "get_capabilities", arguments: {} });
    const get = await client.callTool({ name: "get_mission", arguments: { missionId: context.missionId } });
    const resume = await client.callTool({ name: "resume_mission", arguments: {
      missionId: context.missionId, instructionSnapshot: "Resume safely", provider: "codex",
      idempotencyKey: "mission-safe-resume",
    } });
    expect(get.structuredContent).toMatchObject({ mission: safeMission });
    expect(resume.structuredContent).toMatchObject({ mission: safeMission });
    await client.close();
    await server.close();
  });

  it("exposes only current Flow, run, and artifact tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })),
    );
    const { client, server } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual([
      "get_capabilities",
      "list_projects",
      "start_flow_authoring",
      "advance_flow_authoring",
      "get_flow_authoring",
      "close_flow_authoring",
      "start_mission",
      "resume_mission",
      "attach_to_mission",
      "get_mission",
      "list_missions",
      "update_mission",
      "end_agent_session",
      "get_mission_activity",
      "create_execution_plan",
      "validate_execution_plan",
      "activate_execution_plan",
      "get_orchestration_status",
      "start_ready_objectives",
      "pause_mission_orchestration",
      "resume_mission_orchestration",
      "cancel_mission_orchestration",
      "grant_mission_execution_authorization",
      "relate_mission_activity",
      "create_mission_objective",
      "update_mission_objective",
      "attach_flow_to_mission",
      "list_environments",
      "create_test_environment",
      "list_project_credentials",
      "create_project_credential",
      "authorize_environment_credentials",
      "list_flows",
      "ensure_calibration",
      "list_calibrations",
      "get_calibration",
      "approve_calibration",
      "retry_calibration",
      "cancel_calibration",
      "bind_calibration",
      "create_flow_draft",
      "get_flow_draft",
      "list_mission_flow_drafts",
      "abandon_flow_draft",
      "compile_and_certify_flow",
      "publish_flow_draft",
      "list_authentication_contracts",
      "list_authenticated_session_leases",
      "revoke_authenticated_session_lease",
      "start_run",
      "get_run",
      "get_veil_findings",
      "tighten_veil_preferences",
      "get_protected_recovery",
      "act_on_protected_recovery",
      "accept_objective_evidence",
      "classify_run",
      "set_mission_resume_pointer",
      "publish_mission_report",
      "get_artifact",
      "search_artifact",
      "extract_artifact_html",
    ]);
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("Protected fill example action");
    expect(tools.find(({ name }) => name === "create_test_environment")?.description)
      .toContain("environmentRecovery.missingTrustedScriptOrigins");
    expect(tools.find(({ name }) => name === "create_flow_draft")?.description)
      .toContain("Minimal plan example");
    await client.close();
    await server.close();
  });

  it("advances one grouped authoring turn with a single API request", async () => {
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify(url.pathname.endsWith("/capabilities") ? admittedCapabilities : {
              correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              operationsCompleted: [],
              safeState: { documentEpoch: 1, url: "https://example.test/" },
              decisionBoundary: {
                type: "objective_completed",
                reasonCode: "AUTHORING_TURN_COMPLETED",
                safeActions: [],
              },
              timings: { totalMs: 1 },
              bytesReturned: 128,
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const { client, server } = await connected();
    await client.callTool({ name: "get_capabilities", arguments: {} });
    requests.length = 0;
    const response = await client.callTool({
      name: "advance_flow_authoring",
      arguments: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        kind: "intents",
        intents: [
          {
            intentId: "open-details",
            objectiveId: context.objectiveId,
            flowDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            action: { kind: "navigate", url: "https://example.test/details" },
            expectedEffect: {
              kind: "navigation",
              url: "https://example.test/details",
              match: "path",
            },
            constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
            authorization: { kind: "ordinary" },
            protectedInputReferences: [],
          },
        ],
        budgets: { maxOperations: 1, maxDurationMs: 5_000 },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/mission-flow-authoring/11111111-1111-4111-8111-111111111111/advance",
      body: {
        kind: "intents",
        intents: [expect.objectContaining({ intentId: "open-details" })],
      },
    });
    await client.close();
    await server.close();
  });

  it("exposes the complete Mission-owned authoring lifecycle", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push({
          method: init?.method ?? "GET",
          path,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify(
              path.endsWith("/capabilities") ? admittedCapabilities : { id: sessionId },
            ),
            { status: 200 },
          ),
        );
      }),
    );

    const { client, server } = await connected();
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const environmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const flowDraftId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    for (const request of [
      {
        name: "start_flow_authoring",
        arguments: {
          projectId,
          missionId: context.missionId,
          objectiveId: context.objectiveId,
          flowDraftId,
          environmentId,
          agentSessionId: context.agentSessionId,
          objective: "Inspect the read-only account details",
          allowedOrigins: ["https://example.test"],
        },
      },
      {
        name: "advance_flow_authoring",
        arguments: {
          sessionId,
          kind: "intents",
          intents: [
            {
              intentId: "inspect-details",
              objectiveId: context.objectiveId,
              flowDraftId,
              action: {
                kind: "navigate",
                url: "https://example.test/details",
              },
              expectedEffect: {
                kind: "navigation",
                url: "https://example.test/details",
                match: "exact",
              },
              constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
              authorization: { kind: "ordinary" },
              protectedInputReferences: [],
            },
          ],
          budgets: { maxOperations: 1, maxDurationMs: 30_000 },
        },
      },
      { name: "get_flow_authoring", arguments: { sessionId } },
      {
        name: "close_flow_authoring",
        arguments: { sessionId },
      },
    ]) {
      const response = await client.callTool(request);
      expect(response.isError, request.name).not.toBe(true);
    }

    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/api/capabilities" },
      { method: "POST", path: "/api/mission-flow-authoring" },
      { method: "POST", path: `/api/mission-flow-authoring/${sessionId}/advance` },
      { method: "GET", path: `/api/mission-flow-authoring/${sessionId}` },
      { method: "POST", path: `/api/mission-flow-authoring/${sessionId}/close` },
    ]);
    for (const request of requests.filter(({ method }) => method === "POST")) {
      expect(request.body?.idempotencyKey).toMatch(/^mcp-flow-authoring-/);
    }
    expect(requests[1]?.body).toMatchObject({
      projectId,
      missionId: context.missionId,
      objectiveId: context.objectiveId,
      flowDraftId,
      environmentId,
      objective: "Inspect the read-only account details",
      allowedOrigins: ["https://example.test"],
    });
    expect(requests[2]?.body).toMatchObject({
      kind: "intents",
      intents: [
        expect.objectContaining({
          intentId: "inspect-details",
          authorization: { kind: "ordinary" },
        }),
      ],
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    });
    await client.close();
    await server.close();
  });

  it("preserves a typed release rejection before Adaptive Session state changes", async () => {
    vi.stubEnv("SCRY_RELEASE_ID", "expected-release");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        return Promise.resolve(
          new Response(JSON.stringify({ ...admittedCapabilities, releaseId: "stale-release" }), {
            status: 200,
          }),
        );
      }),
    );

    const { client, server } = await connected();
    const response = await client.callTool({
      name: "start_flow_authoring",
      arguments: {
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        missionId: context.missionId,
        objectiveId: context.objectiveId,
        flowDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentSessionId: context.agentSessionId,
        objective: "Inspect account details",
        allowedOrigins: ["https://example.test"],
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      rejection: {
        code: "SCRY_RELEASE_MISMATCH",
        safeActions: ["restart_mcp_with_current_release", "verify_api_release"],
      },
    });
    expect(requests).toEqual(["/api/capabilities"]);
    await client.close();
    await server.close();
  });

  it("creates a credential without returning its sensitive value", async () => {
    const sensitiveValue = "explicit-user-secret";
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              name: "Preview login password",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              value: sensitiveValue,
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "create_project_credential",
      arguments: {
        ...context,
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Preview login password",
        value: sensitiveValue,
        purpose: "Sign in to the explicitly requested preview environment",
        confirmedUserProvided: true,
      },
    });
    expect(requests).toEqual([
      {
        path: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/credentials",
        body: { ...context, name: "Preview login password", value: sensitiveValue },
      },
    ]);
    expect(JSON.stringify(response)).not.toContain(sensitiveValue);
    expect(response.structuredContent).toMatchObject({
      credential: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Preview login password" },
    });
    await client.close();
    await server.close();
  });

  it("adds credential references to an environment without replacing its allowlist", async () => {
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const body =
          init?.method === "PATCH"
            ? {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                name: "Preview",
                baseOrigin: "https://preview.example.com",
                secretRefs: [
                  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                ],
              }
            : [
                {
                  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  baseOrigin: "https://preview.example.com",
                  policy: {
                    allowedOrigins: ["https://preview.example.com"],
                    allowPrivateNetwork: false,
                    allowDownloads: false,
                    maxRequests: 100,
                    blockedResourceTypes: [],
                  },
                  secretRefs: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
                },
              ];
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "authorize_environment_credentials",
      arguments: {
        ...context,
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        credentialIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      },
    });
    expect(response.isError).not.toBe(true);
    expect(requests[1]?.body).toMatchObject({
      ...context,
      secretRefs: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    });
    await client.close();
    await server.close();
  });

  it("starts a run only with an admitted compiled contract", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const response = url.pathname.endsWith("/capabilities")
          ? admittedCapabilities
          : { runId: "11111111-1111-4111-8111-111111111111", state: "queued" };
        return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "start_run",
      arguments: {
        ...context,
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        flowRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        compiledContractId: "99999999-9999-4999-8999-999999999999",
      },
    });
    expect(response.isError).not.toBe(true);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/capabilities",
      "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs",
    ]);
    expect(requests[1]?.body).toMatchObject({
      flowRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      compiledContractId: "99999999-9999-4999-8999-999999999999",
      browser: "chromium",
    });
    await client.close();
    await server.close();
  });

  it("rejects compile and certify before writing when the API release mismatches", async () => {
    vi.stubEnv("SCRY_RELEASE_ID", "expected-release");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        return Promise.resolve(
          new Response(JSON.stringify({ ...admittedCapabilities, releaseId: "stale-release" }), {
            status: 200,
          }),
        );
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "compile_and_certify_flow",
      arguments: {
        ...context,
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        draftVersion: 1,
        probeSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      rejection: {
        code: "SCRY_RELEASE_MISMATCH",
        safeActions: ["restart_mcp_with_current_release", "verify_api_release"],
      },
    });
    expect(requests).toEqual(["/api/capabilities"]);
    await client.close();
    await server.close();
  });

  it("rejects publication before writing when the API schema mismatches", async () => {
    vi.stubEnv("SCRY_SCHEMA_FINGERPRINT", "expected-schema");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        return Promise.resolve(
          new Response(
            JSON.stringify({ ...admittedCapabilities, schemaFingerprint: "stale-schema" }),
            { status: 200 },
          ),
        );
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "publish_flow_draft",
      arguments: {
        ...context,
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedVersion: 1,
        compilationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        reason: "Publish certified contract",
      },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      rejection: {
        code: "SCRY_RELEASE_MISMATCH",
        safeActions: ["restart_mcp_with_current_release", "verify_api_release"],
      },
    });
    expect(requests).toEqual(["/api/capabilities"]);
    await client.close();
    await server.close();
  });

  it("returns the exact compiled contract identity from publication", async () => {
    const compiledContractId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        const body = path.endsWith("/capabilities")
          ? admittedCapabilities
          : {
              flowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              revision: 1,
              compilationId: compiledContractId,
              compiledContractId,
            };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "publish_flow_draft",
      arguments: {
        ...context,
        draftId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        expectedVersion: 1,
        compilationId: compiledContractId,
        reason: "Publish certified contract",
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      publication: { compilationId: compiledContractId, compiledContractId },
    });
    expect(requests).toEqual([
      "/api/capabilities",
      "/api/flow-drafts/dddddddd-dddd-4ddd-8ddd-dddddddddddd/publish",
    ]);
    await client.close();
    await server.close();
  });

  it("preserves typed certification rejection actions through the authoring tool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/capabilities")) {
          return Promise.resolve(
            new Response(JSON.stringify(admittedCapabilities), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              statusCode: 409,
              message: {
                code: "EXECUTION_READY_COMPILATION_REQUIRED",
                safeActions: ["revise_flow", "compile_and_certify_flow"],
              },
            }),
            { status: 409 },
          ),
        );
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "compile_and_certify_flow",
      arguments: {
        ...context,
        draftId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        draftVersion: 1,
        probeSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      rejection: {
        code: "EXECUTION_READY_COMPILATION_REQUIRED",
        safeActions: ["revise_flow", "compile_and_certify_flow"],
      },
    });
    await client.close();
    await server.close();
  });

  it("returns the canonical observation instead of a metadata-only run projection", async () => {
    const observation = {
      run: { id: "11111111-1111-4111-8111-111111111111", state: "failed" },
      steps: [{ stepId: "sign-in", action: { status: "failed", error: "Target was not found" } }],
      artifacts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          resource: "scry://artifact/22222222-2222-4222-8222-222222222222",
        },
      ],
      artifactTimeline: [],
      integrity: { status: "complete", issues: [] },
      safeActions: ["rerun", "revise_flow", "read_artifact"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(observation), { status: 200 })),
    );
    const { client, server } = await connected();

    const response = await client.callTool({
      name: "get_run",
      arguments: { runId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(response.structuredContent).toMatchObject({
      observation: {
        steps: observation.steps,
        artifacts: observation.artifacts,
        integrity: observation.integrity,
      },
    });
    await client.close();
    await server.close();
  });

  it("exposes safe Veil findings and sends tightening requests to the authoritative API", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const body =
          url.pathname.endsWith("/veil") && (init?.method ?? "GET") === "GET"
            ? {
                effectiveProfile: "private",
                policyDigest: "a".repeat(64),
                findings: [],
                gaps: [],
                timeline: [],
              }
            : { effectivePolicy: { profile: "minimal_capture", digest: "b".repeat(64) } };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { client, server } = await connected();
    await client.callTool({
      name: "get_veil_findings",
      arguments: { runId: "11111111-1111-4111-8111-111111111111" },
    });
    const tightened = await client.callTool({
      name: "tighten_veil_preferences",
      arguments: {
        environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        profile: "minimal_capture",
        reasonCode: "VEIL_AGENT_REQUESTED_PRIVACY",
      },
    });
    expect(requests).toEqual([
      { method: "GET", path: "/api/runs/11111111-1111-4111-8111-111111111111/veil" },
      {
        method: "PATCH",
        path: "/api/environments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/veil",
        body: { profile: "minimal_capture", reasonCode: "VEIL_AGENT_REQUESTED_PRIVACY" },
      },
    ]);
    expect(tightened.structuredContent).toMatchObject({
      veil: { effectivePolicy: { profile: "minimal_capture" } },
    });
    await client.close();
    await server.close();
  });

  it("requests an authenticated calibration rehearsal without accepting agent-authored structure", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              calibrationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              state: "rehearsal_queued",
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const { client, server } = await connected();
    await client.callTool({
      name: "ensure_calibration",
      arguments: {
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        calibration: {
          ...context,
          name: "Credential generation",
          sourceFlowRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          operationId: "generate-api-secret",
          environmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          disposableDataConfirmed: true,
          confirmedUserAuthorized: true,
          purpose: "Generate a disposable test API credential requested by the user",
          idempotencyKey: "calibration-request-1",
        },
      },
    });
    expect(requests[0]).toMatchObject({
      path: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/calibration-sessions",
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("structure");
    await client.close();
    await server.close();
  });

  it("approves only an exact attested revision with explicit user authorization", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(
          new Response(JSON.stringify({ status: "approved" }), { status: 200 }),
        );
      }),
    );
    const { client, server } = await connected();
    const response = await client.callTool({
      name: "approve_calibration",
      arguments: {
        ...context,
        calibrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        attestationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        confirmedUserAuthorized: true,
        reasonCode: "USER_AUTHORIZED_AGENT_CALIBRATION",
      },
    });
    expect(response.isError).not.toBe(true);
    expect(requests[0]).toEqual({
      path: "/api/calibrations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attestations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/approve",
      body: {
        ...context,
        reasonCode: "USER_AUTHORIZED_AGENT_CALIBRATION",
        confirmedUserAuthorized: true,
      },
    });
    await client.close();
    await server.close();
  });
});

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createScryMcpServer(new ScryApiClient("http://scry.test/api"));
  const client = new Client({ name: "scry-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
