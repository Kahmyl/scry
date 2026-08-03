import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());
const context={missionId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",objectiveId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",agentSessionId:"ffffffff-ffff-4fff-8fff-ffffffffffff"};
const admittedCapabilities = { releaseId: "development", schemaFingerprint: "development-baseline", supportedActions: [], evidenceChannels: [], artifactCapabilities: [], collectorCapabilities: [], praxis: { contractVersion: 1, runtimeVersion: "1", scoringPolicyVersion: 1, cutoff: true, evidenceChannels: [], strategies: [], hardBoundaries: [] } };

describe("current Scry MCP surface", () => {
  it("exposes only current Flow, run, and artifact tools", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })));
    const { client, server } = await connected();
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "get_capabilities", "list_projects","start_mission","resume_mission","attach_to_mission","get_mission","list_missions","update_mission","end_agent_session","get_mission_activity","create_execution_plan","validate_execution_plan","activate_execution_plan","get_orchestration_status","start_ready_objectives","pause_mission_orchestration","resume_mission_orchestration","cancel_mission_orchestration","grant_mission_execution_authorization","relate_mission_activity","create_mission_objective","update_mission_objective","attach_flow_to_mission", "list_environments", "create_test_environment",
      "list_project_credentials", "create_project_credential", "authorize_environment_credentials", "list_flows", "ensure_calibration", "list_calibrations", "get_calibration", "approve_calibration", "retry_calibration", "cancel_calibration", "bind_calibration", "validate_test_plan", "create_flow_draft", "update_flow_draft", "get_flow_draft", "list_mission_flow_drafts", "abandon_flow_draft", "start_probe_session", "get_probe_session", "cancel_probe_session", "compile_flow_draft", "publish_flow_draft", "list_authentication_contracts", "list_authenticated_session_leases", "revoke_authenticated_session_lease",
      "start_run", "get_run","get_veil_findings","tighten_veil_preferences","get_protected_recovery","act_on_protected_recovery","accept_objective_evidence","classify_run","set_mission_resume_pointer","publish_mission_report", "get_artifact", "search_artifact", "extract_artifact_html",
    ]);
    await client.close(); await server.close();
  });

  it("creates a credential without returning its sensitive value", async () => {
    const sensitiveValue = "explicit-user-secret";
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Promise.resolve(new Response(JSON.stringify({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Preview login password",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        value: sensitiveValue,
      }), { status: 200 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "create_project_credential", arguments: {
      ...context,
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Preview login password",
      value: sensitiveValue,
      purpose: "Sign in to the explicitly requested preview environment",
      confirmedUserProvided: true,
    } });
    expect(requests).toEqual([{ path: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/credentials", body: { ...context,name: "Preview login password", value: sensitiveValue } }]);
    expect(JSON.stringify(response)).not.toContain(sensitiveValue);
    expect(response.structuredContent).toMatchObject({ credential: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Preview login password" } });
    await client.close(); await server.close();
  });

  it("adds credential references to an environment without replacing its allowlist", async () => {
    const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const body = init?.method === "PATCH"
        ? { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Preview", baseOrigin: "https://preview.example.com", secretRefs: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"] }
        : [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", baseOrigin: "https://preview.example.com", policy: { allowedOrigins: ["https://preview.example.com"], allowPrivateNetwork: false, allowDownloads: false, maxRequests: 100, blockedResourceTypes: [] }, secretRefs: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "authorize_environment_credentials", arguments: {
      ...context,
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      credentialIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    } });
    expect(response.isError).not.toBe(true);
    expect(requests[1]?.body).toMatchObject({...context,secretRefs:["cccccccc-cccc-4ccc-8ccc-cccccccccccc","dddddddd-dddd-4ddd-8ddd-dddddddddddd"]});
    await client.close(); await server.close();
  });

  it("starts a run only with an admitted compiled contract", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const response = url.pathname.endsWith("/capabilities")
        ? admittedCapabilities
        : { runId: "11111111-1111-4111-8111-111111111111", state: "queued" };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "start_run", arguments: {
      ...context,
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      flowRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      compiledContractId: "99999999-9999-4999-8999-999999999999",
    } });
    expect(response.isError).not.toBe(true);
    expect(requests.map(({ path }) => path)).toEqual(["/api/capabilities", "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs"]);
    expect(requests[1]?.body).toMatchObject({ flowRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", compiledContractId: "99999999-9999-4999-8999-999999999999", browser: "chromium" });
    await client.close(); await server.close();
  });

  it("delegates plan validation to the authoritative API", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/capabilities")
        ? admittedCapabilities
        : { valid: true, errors: [], warnings: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const plan = { name: "Smoke", objective: "Open the app", preconditions: [], allowedOrigins: ["https://example.com"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [{ id: "open", title: "Open", action: { type: "navigate", url: "/" }, after: { mode: "all", timeoutMs: 1_000, conditions: [{ type: "delay", durationMs: 100 }] }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" }] };
    const response = await client.callTool({ name: "validate_test_plan", arguments: {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", plan,
    } });
    expect(response.structuredContent).toMatchObject({ valid: true, errors: [], warnings: [] });
    await client.close(); await server.close();
  });

  it("returns the canonical observation instead of a metadata-only run projection", async () => {
    const observation = {
      run: { id: "11111111-1111-4111-8111-111111111111", state: "failed" },
      steps: [{ stepId: "sign-in", action: { status: "failed", error: "Target was not found" } }],
      artifacts: [{ id: "22222222-2222-4222-8222-222222222222", resource: "scry://artifact/22222222-2222-4222-8222-222222222222" }],
      artifactTimeline: [],
      integrity: { status: "complete", issues: [] },
      safeActions: ["rerun", "revise_flow", "read_artifact"],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(observation), { status: 200 })));
    const { client, server } = await connected();

    const response = await client.callTool({ name: "get_run", arguments: { runId: "11111111-1111-4111-8111-111111111111" } });

    expect(response.structuredContent).toMatchObject({ observation: { steps: observation.steps, artifacts: observation.artifacts, integrity: observation.integrity } });
    await client.close(); await server.close();
  });

  it("exposes safe Veil findings and sends tightening requests to the authoritative API", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const body = url.pathname.endsWith("/veil") && (init?.method ?? "GET") === "GET"
        ? { effectiveProfile: "private", policyDigest: "a".repeat(64), findings: [], gaps: [], timeline: [] }
        : { effectivePolicy: { profile: "minimal_capture", digest: "b".repeat(64) } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    const { client, server } = await connected();
    await client.callTool({ name: "get_veil_findings", arguments: { runId: "11111111-1111-4111-8111-111111111111" } });
    const tightened = await client.callTool({ name: "tighten_veil_preferences", arguments: {
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", profile: "minimal_capture", reasonCode: "VEIL_AGENT_REQUESTED_PRIVACY",
    } });
    expect(requests).toEqual([
      { method: "GET", path: "/api/runs/11111111-1111-4111-8111-111111111111/veil" },
      { method: "PATCH", path: "/api/environments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/veil", body: { profile: "minimal_capture", reasonCode: "VEIL_AGENT_REQUESTED_PRIVACY" } },
    ]);
    expect(tightened.structuredContent).toMatchObject({ veil: { effectivePolicy: { profile: "minimal_capture" } } });
    await client.close(); await server.close();
  });

  it("requests an authenticated calibration rehearsal without accepting agent-authored structure", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({ calibrationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", state: "rehearsal_queued" }), { status: 200 }));
    }));
    const { client, server } = await connected();
    await client.callTool({ name: "ensure_calibration", arguments: {
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
    } });
    expect(requests[0]).toMatchObject({ path: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/calibration-sessions" });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("structure");
    await client.close(); await server.close();
  });

  it("approves only an exact attested revision with explicit user authorization", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({ status: "approved" }), { status: 200 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "approve_calibration", arguments: {
      ...context,
      calibrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attestationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      confirmedUserAuthorized: true,
      reasonCode: "USER_AUTHORIZED_AGENT_CALIBRATION",
    } });
    expect(response.isError).not.toBe(true);
    expect(requests[0]).toEqual({path:"/api/calibrations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/attestations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/approve",body:{...context,reasonCode:"USER_AUTHORIZED_AGENT_CALIBRATION",confirmedUserAuthorized:true}});
    await client.close(); await server.close();
  });
});

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createScryMcpServer(new ScryApiClient("http://scry.test/api"));
  const client = new Client({ name: "scry-test", version: "1.0.0" });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, server };
}
