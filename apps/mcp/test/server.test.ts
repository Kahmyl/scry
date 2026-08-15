import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";
import { SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS } from "../src/server-composition.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("SCRY_LEGACY_MCP_FIXTURES", "true");
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
  it("exposes the agent-first public surface without legacy admission or progression tools", async () => {
    vi.stubEnv("SCRY_LEGACY_MCP_FIXTURES", "");
    const { client, server } = await connected();
    const tools = (await client.listTools()).tools;
    const names = tools.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      "start_praxis_session", "observe_praxis_session", "get_praxis_session",
      "close_praxis_session", "start_run", "dispatch_run_operation",
      "attach_run_praxis_session", "finalize_run",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "advance_flow_authoring", "prepare_flow_authoring", "start_flow_authoring",
      "ensure_calibration", "bind_calibration", "create_execution_plan",
      "activate_execution_plan", "start_ready_objectives",
      "pause_mission_orchestration", "resume_mission_orchestration",
    ]));
    const observe = tools.find(({ name }) => name === "observe_praxis_session")!;
    expect(observe.description).toContain("opaque context-control references");
    const dispatch = tools.find(({ name }) => name === "dispatch_run_operation")!;
    expect(dispatch.description).toContain("semantic-only targets");
    expect(dispatch.description).toContain("no selector fallback");
    await client.close();
    await server.close();
  });

  it("exposes privacy-safe structural grouping through the negotiated MCP instructions", async () => {
    expect(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS).toContain("containerReferences");
    expect(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS).toContain("privacy-safe grouping");
    expect(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS).toContain("not action targets or resource identity");
    expect(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS).toContain("Never select by list order");
    expect(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS).toContain("request clarification");
    const { client, server } = await connected();
    expect(client.getInstructions()).toContain(SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS);
    await client.close();
    await server.close();
  });
  it("returns the operating-context message envelope accepted by its host schema", async () => {
    const payload = {
      selection: { project: null, requiresProjectSelection: false,
        projectCandidates: { items: [], truncated: false } },
      missions: { candidates: { items: [], truncated: false } },
      credentials: { items: [], truncated: false }, environments: { items: [], truncated: false },
      authoring: { reusable: { items: [], truncated: false }, recoverable: { items: [], truncated: false },
        uncertain: { items: [], truncated: false }, ready: false,
        missing: ["project", "mission", "objective", "environment", "flow_draft", "authoring_session"] },
      continuation: { deterministicPreparationAvailable: false, userAuthorityRequired: false,
        safeActions: ["create_project_in_dashboard"], blockerCode: "NO_PROJECT" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "get_operating_context", arguments: {} });
    expect(response.structuredContent).toMatchObject({ message: expect.any(String), ...payload });
    await client.close();
    await server.close();
  });

  it("returns the shared safe Mission projection unchanged for get and resume", async () => {
    const safeMission = {
      id: context.missionId,
      status: "awaiting_user",
      resumePointer: {
        objectiveId: context.objectiveId,
        recommendedAction: "await_user",
        explanation: "A factual decision is pending",
        externalInput: {
          condition: "USER_DECISION_REQUIRED",
          cause: "The external operation requires a user-owned decision.",
          affectedOperation: "operation-ref",
          effectState: "unknown",
          authority: {
            required: true,
            type: "user",
            reason: "Only the user can supply this decision.",
          },
          availableCapabilities: ["resume_mission", "update_mission_objective"],
          fulfillmentPaths: [{
            kind: "selection",
            humanAction: "Choose the authoritative option.",
            agentExposure: "public_input",
            result: "The same task can resume.",
            availableCapabilities: ["resume_mission"],
            continuation: { sameMission: true, sameObjective: true,
              replacementMissionRequired: false, resumeWith: "resume_mission" },
          }],
          constraints: ["Do not retry while the effect remains unknown."],
          consequences: ["Continuation requires authoritative re-observation."],
          continuation: {
            retryCurrentOperation: false,
            freshObservationRequired: true,
            newOperationRequired: true,
            newDraftRequired: false,
            newSessionRequired: false,
          },
          waiting: true,
          terminal: false,
          lifecycle: { terminal: false, taskStillActive: true, sameMissionResumable: true,
            sameObjectiveResumable: true, shouldFinalize: false,
            shouldPublishFinalReport: false, shouldCreateReplacementMission: false,
            requiredNextStep: "fulfill_human_prerequisite_then_resume" },
          resumeRef: context.objectiveId,
        },
      },
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
      "get_operating_context",
      "prepare_flow_authoring",
      "start_flow_authoring",
      "advance_flow_authoring",
      "recover_trusted_script_origins",
      "get_flow_authoring",
      "reconcile_unknown_operation",
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
      "finalize_agent_work",
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
      "publish_flow_draft",
      "list_authentication_contracts",
      "list_authenticated_session_leases",
      "revoke_authenticated_session_lease",
      "start_run",
      "dispatch_run_operation",
      "attach_run_praxis_session",
      "finalize_run",
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
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("Ordinary fill example action");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("inputSources: literal or protected_reference");
    expect(tools.find(({ name }) => name === "create_test_environment")?.description)
      .toContain("environmentRecovery.missingTrustedScriptOrigins");
    expect(tools.find(({ name }) => name === "create_test_environment")?.description)
      .toContain("maxNavigations 1-50");
    expect(tools.find(({ name }) => name === "create_flow_draft")?.description)
      .toContain("plan.steps is required with at least one item");
    expect(tools.find(({ name }) => name === "create_flow_draft")?.description)
      .toContain("waitFor+target+state");
    expect(tools.find(({ name }) => name === "create_flow_draft")?.description)
      .toContain("not the simpler advance_flow_authoring semantic target");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("the public field is reference, never authoritativeReference");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("wait_for requires state, one of visible, hidden, attached, detached");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("Valid roles: button, checkbox, combobox");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("allowNonExact has no implicit default");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("urlPattern is also accepted as a host-compatible alias");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("login/authentication submit");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("Protected acquisition must be atomic with its preparation intents in the same turn");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("action has no top-level target");
    expect(tools.find(({ name }) => name === "set_mission_resume_pointer")?.description)
      .toContain("must exactly equal pointer.objectiveId");
    expect(tools.find(({ name }) => name === "set_mission_resume_pointer")?.description)
      .toContain("never prefix it with 'objective:'");
    const resumePointerSchema = tools.find(({ name }) => name === "set_mission_resume_pointer")!
      .inputSchema as any;
    expect(resumePointerSchema.properties.pointer.anyOf[0].properties.externalInput.properties.resumeRef)
      .toMatchObject({ type: "string", format: "uuid" });
    expect(tools.find(({ name }) => name === "recover_trusted_script_origins")?.description)
      .toContain("Navigation is not performed");
    const draftSchema = tools.find(({ name }) => name === "create_flow_draft")!
      .inputSchema as any;
    const stepsSchema = draftSchema.properties.plan.properties.steps;
    expect(stepsSchema.minItems).toBe(1);
    expect(stepsSchema.items.required).toEqual(
      expect.arrayContaining(["id", "title", "action"]),
    );
    expect(stepsSchema.items.properties.action.properties.type.enum)
      .toEqual(expect.arrayContaining(["navigate", "waitFor", "fill", "click"]));
    expect(stepsSchema.items.properties.action.properties).toEqual(expect.objectContaining({
      url: expect.any(Object), target: expect.any(Object), state: expect.any(Object),
      secretRef: expect.any(Object), expectedStatus: expect.any(Object),
    }));
    expect(draftSchema.properties.plan.properties.checkpoints.items.required).toEqual(
      expect.arrayContaining([
        "id", "beforeStepId", "restorationUrl", "verificationAssertions",
        "continueAtStepId", "maxRestorations", "state",
      ]),
    );
    const authoringSchema = tools.find(({ name }) => name === "advance_flow_authoring")!
      .inputSchema as any;
    const intentSchema = authoringSchema.properties.intents.items;
    const actionSchema = intentSchema.properties.action;
    expect(actionSchema.properties.kind.enum).toEqual(expect.arrayContaining([
      "navigate", "fill", "wait_for", "same_origin_request",
    ]));
    expect(actionSchema.properties.publicValue.description).toContain("Ordinary literal fill source");
    expect(actionSchema.properties.protectedReferenceId).toMatchObject({ type: "string", format: "uuid" });
    expect(actionSchema.properties.protectedReferenceId.description).toContain("Opaque Project credential UUID");
    expect(intentSchema.properties.protectedInputReferences.description)
      .toContain("exactly [action.protectedReferenceId]");
    expect(actionSchema.properties.state.enum).toEqual(["visible", "hidden", "attached", "detached"]);
    expect(actionSchema.properties.target.properties.reference.pattern)
      .toBe("^context-control-[a-f0-9]{32}$");
    expect(actionSchema.properties.target.properties.scope.properties.kind.enum)
      .toEqual(expect.arrayContaining(["dialog", "section", "row", "live_region"]));
    expect(intentSchema.properties.credentialLifecycle.properties.effect.const).toBe("revoke");
    expect(actionSchema.properties.syntheticProtectedSource.properties.generatorContract.enum)
      .toEqual(expect.arrayContaining(["reserved_test_email", "opaque_operation_token"]));
    expect(tools.find(({ name }) => name === "list_projects")?.description)
      .toContain("MCP has no project-creation capability");
    expect(tools.find(({ name }) => name === "get_operating_context")?.description)
      .toContain("never returns protected values");
    expect(tools.find(({ name }) => name === "prepare_flow_authoring")?.description)
      .toContain("performs no authored browser navigation");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("allowNewPage alone grants permission but does not arm safe new-page adoption");
    const preparationSchema = tools.find(({ name }) => name === "prepare_flow_authoring")!
      .inputSchema as any;
    expect(preparationSchema.properties.draft.properties.plan.properties.steps.items.properties.action
      .properties.type.enum).toEqual(expect.arrayContaining(["navigate", "click", "waitFor"]));
    const operatingContextInput = tools.find(({ name }) => name === "get_operating_context")!
      .inputSchema as any;
    expect(operatingContextInput.properties.requiredCredentialReferences.maxItems).toBe(20);
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("unknown forbids blind retry");
    expect(tools.find(({ name }) => name === "start_flow_authoring")?.description)
      .toContain("maxDurationMs 1000-60000");
    expect(tools.find(({ name }) => name === "advance_flow_authoring")?.description)
      .toContain("observable role/name/label/placeholder/text/testId fact");
    expect(tools.find(({ name }) => name === "end_agent_session")?.description)
      .toContain("Required final lifecycle write");
    expect(tools.find(({ name }) => name === "finalize_agent_work")?.description)
      .toContain("cannot terminalize an UNKNOWN");
    expect(tools.find(({ name }) => name === "finalize_agent_work")?.description)
      .toContain("NON-TERMINAL");
    expect(tools.find(({ name }) => name === "create_project_credential")?.description)
      .toContain("agent/model sees that source plaintext");
    expect(tools.find(({ name }) => name === "list_project_credentials")?.description)
      .toContain("Project settings → Test credentials → Add credential");
    const credentialListSchema = tools.find(({ name }) => name === "list_project_credentials")!
      .inputSchema as any;
    expect(credentialListSchema.properties.credentialReferenceId.format).toBe("uuid");
    expect(tools.find(({ name }) => name === "cancel_mission_orchestration")?.description)
      .toContain("explicit user cancellation");
    const externalInputSchema = resumePointerSchema.properties.pointer.anyOf[0]
      .properties.externalInput.properties;
    expect(externalInputSchema.lifecycle.required).toEqual(expect.arrayContaining([
      "terminal", "taskStillActive", "sameMissionResumable", "sameObjectiveResumable",
      "shouldFinalize", "shouldPublishFinalReport", "shouldCreateReplacementMission",
      "requiredNextStep",
    ]));
    const fulfillmentSchema = JSON.stringify(externalInputSchema.fulfillmentPaths.items);
    expect(fulfillmentSchema).toContain("protected_plaintext_before_encrypted_storage");
    expect(fulfillmentSchema).toContain("dashboard_managed");
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
              urlPattern: "https://example.test/details",
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
    requests.length = 0;
    const credentialReference = "99999999-9999-4999-8999-999999999999";
    const protectedFill = await client.callTool({
      name: "advance_flow_authoring",
      arguments: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        kind: "intents",
        intents: [{
          intentId: "fill-password",
          objectiveId: context.objectiveId,
          flowDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          action: { kind: "fill", target: { concept: "password", role: "textbox" },
            protectedReferenceId: credentialReference },
          expectedEffect: { kind: "none" },
          constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: true },
          authorization: { kind: "authentication" },
          protectedInputReferences: [credentialReference],
        }],
        budgets: { maxOperations: 1, maxDurationMs: 5_000 },
      },
    });
    expect(protectedFill.isError).not.toBe(true);
    expect(requests[0]?.body).toMatchObject({
      intents: [{
        action: { kind: "fill", protectedReferenceId: credentialReference },
        protectedInputReferences: [credentialReference],
      }],
    });
    requests.length = 0;
    const ordinaryFill = await client.callTool({
      name: "advance_flow_authoring",
      arguments: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        kind: "intents",
        intents: [{
          intentId: "fill-public-name",
          objectiveId: context.objectiveId,
          flowDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          action: { kind: "fill", target: { concept: "credential name", role: "textbox" },
            publicValue: "Qualification credential" },
          expectedEffect: { kind: "none" },
          constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "ordinary" },
          protectedInputReferences: [],
        }],
        budgets: { maxOperations: 1, maxDurationMs: 5_000 },
      },
    });
    expect(ordinaryFill.isError).not.toBe(true);
    expect(requests[0]?.body).toMatchObject({
      intents: [{ action: { kind: "fill", publicValue: "Qualification credential" },
        protectedInputReferences: [] }],
    });
    requests.length = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const continuation = await client.callTool({
        name: "advance_flow_authoring",
        arguments: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          kind: "continue",
          turnId: "22222222-2222-4222-8222-222222222222",
          budgets: { maxOperations: 1, maxDurationMs: 5_000 },
        },
      });
      expect(continuation.isError).not.toBe(true);
    }
    expect(requests).toHaveLength(2);
    const continuationKeys = requests.map(({ body }) => body?.idempotencyKey);
    expect(continuationKeys[0]).toMatch(/^flow-authoring-continuation-/);
    expect(continuationKeys[1]).toMatch(/^flow-authoring-continuation-/);
    expect(continuationKeys[0]).not.toBe(continuationKeys[1]);
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

  it("preserves safe causal rejection context through the external MCP result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/capabilities")) return Promise.resolve(new Response(JSON.stringify(admittedCapabilities), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({
        statusCode: 409,
        message: {
          code: "ENVIRONMENT_CAPABILITY_INCOMPLETE",
          capability: "allowed_origins",
          missingCount: 1,
          mutationOutcome: "not_applied",
          retry: "safe_after_prerequisite",
          safeActions: ["list_environments", "create_test_environment"],
          unsafeDiagnostic: "must-not-escape",
        },
      }), { status: 409 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "start_flow_authoring", arguments: {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      missionId: context.missionId,
      objectiveId: context.objectiveId,
      flowDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentSessionId: context.agentSessionId,
      objective: "Inspect account details",
      allowedOrigins: ["https://example.test"],
    } });
    expect(response.structuredContent).toMatchObject({ rejection: {
      code: "ENVIRONMENT_CAPABILITY_INCOMPLETE",
      appliedState: "not_applied",
      retry: "safe_after_prerequisite",
      context: { capability: "allowed_origins", missingCount: 1 },
      safeActions: ["list_environments", "create_test_environment"],
    } });
    expect(JSON.stringify(response)).not.toContain("must-not-escape");
    await client.close(); await server.close();
  });

  it("keeps safe rejection context when a direct tool delegates error translation to MCP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      statusCode: 409,
      message: {
        code: "AUTHORING_DRAFT_CONTEXT_MISMATCH",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: ["create_objective_scoped_draft"],
        unsafeDiagnostic: "must-not-escape",
      },
    }), { status: 409 })));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "create_flow_draft", arguments: {
      ...context,
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Read-only fixture",
      content: { objective: "Observe", expectedOutcomes: ["Page visible"], preconditions: [], prohibitedSideEffects: [] },
      plan: { name: "Observe", objective: "Observe", allowedOrigins: ["https://example.test"], budgets: { maxActions: 1, maxDurationMs: 1000, maxNavigations: 1 }, checkpoints: [], steps: [{ id: "open", title: "Open", action: { type: "navigate", url: "https://example.test" }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" }] },
    } });
    const serialized = JSON.stringify(response);
    expect(response.isError).toBe(true);
    expect(serialized).toContain("AUTHORING_DRAFT_CONTEXT_MISMATCH");
    expect(serialized).toContain("not_applied");
    expect(serialized).not.toContain("must-not-escape");
    await client.close(); await server.close();
  });

  it.each([
    ["update_mission_objective", { ...context, objectiveId: context.objectiveId, status: "blocked", conclusion: "No safe continuation" }],
    ["publish_mission_report", { missionId: context.missionId, agentSessionId: context.agentSessionId, overallConclusion: "Mission complete", journeySummary: ["Verified"], expectedRevision: 1 }],
  ])("returns machine-readable agent-session finalization after terminal work via %s", async (name, args) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "terminal-resource" }), { status: 200 })));
    const { client, server } = await connected();
    const response = await client.callTool({ name, arguments: args });
    expect(response.structuredContent).toMatchObject({ agentSessionFinalization: {
      required: true,
      tool: "end_agent_session",
      agentSessionId: context.agentSessionId,
      recommendedStatus: expect.stringMatching(/^(completed|failed)$/),
    } });
    await client.close(); await server.close();
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

  it("lists bounded safe credential metadata and preserves ambiguity", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      requested.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({
      items: [
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          referenceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Preview password",
          securityStatus: "active", eligibleForAuthorization: true, authorizedEnvironmentIds: [],
          authorizedEnvironmentIdsTruncated: false,
          createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
        { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          referenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Preview password old",
          securityStatus: "revoked", eligibleForAuthorization: false, authorizedEnvironmentIds: [],
          authorizedEnvironmentIdsTruncated: true,
          createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      ], truncated: true,
    }), { status: 200 }));
    }));
    const { client, server } = await connected();
    const response = await client.callTool({ name: "list_project_credentials", arguments: {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } });
    expect(response.structuredContent).toMatchObject({ credentials: {
      truncated: true, items: [
        { name: "Preview password", securityStatus: "active", eligibleForAuthorization: true },
        { name: "Preview password old", securityStatus: "revoked",
          eligibleForAuthorization: false, authorizedEnvironmentIdsTruncated: true },
      ],
    } });
    expect(JSON.stringify(response)).not.toContain("value");
    expect(JSON.stringify(response)).toContain("do not infer uniqueness");
    await client.callTool({ name: "list_project_credentials", arguments: {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credentialReferenceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    } });
    expect(requested[0]).toContain("/credential-candidates");
    expect(requested[1]).toContain("referenceId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await client.close(); await server.close();
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

  it("opens an agent-directed Run only with an explicit live Praxis session", async () => {
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
        praxisSessionId: "99999999-9999-4999-8999-999999999999",
      },
    });
    expect(response.isError).not.toBe(true);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/capabilities",
      "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs",
    ]);
    expect(requests[1]?.body).toMatchObject({
      flowRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      praxisSessionId: "99999999-9999-4999-8999-999999999999",
      browser: "chromium",
    });
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
