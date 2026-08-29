import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { Q5_MCP_CONTRACT_DIGEST } from "@scry/contracts";
import {
  createQ5McpServer,
  inspectQ5McpContract,
  Q5_MCP_PROFILE,
  Q5_MCP_TOOL_NAMES,
} from "../src/qualification/q5-server.js";
import { Q5ScopedApiClient, type Q5Scope } from "../src/qualification/q5-scoped-api-client.js";

afterEach(() => vi.unstubAllGlobals());

const scope: Q5Scope = {
  attemptId: "10000000-0000-4000-8000-000000000001",
  state: "prepared",
  campaignId: "10000000-0000-4000-8000-000000000002",
  canonicalApplicationId: "10000000-0000-4000-8000-000000000003",
  applicationIdentity: "vitract-preview-test",
  projectId: "10000000-0000-4000-8000-000000000004",
  environmentId: "10000000-0000-4000-8000-000000000005",
  missionId: "10000000-0000-4000-8000-000000000006",
  objectiveId: "10000000-0000-4000-8000-000000000007",
  agentSessionId: "10000000-0000-4000-8000-000000000008",
  externalRunId: "10000000-0000-4000-8000-000000000009",
  flowDraftId: "10000000-0000-4000-8000-000000000010",
  flowRevisionId: "10000000-0000-4000-8000-000000000011",
  targetOrigin: "https://preview-api.vitract.com",
  allowedOrigins: ["https://preview-api.vitract.com"],
  credentialReferenceIds: ["10000000-0000-4000-8000-000000000012"],
  runId: "10000000-0000-4000-8000-000000000013",
  praxisSessionId: "10000000-0000-4000-8000-000000000014",
};

describe("authoritative Q5 MCP profile", () => {
  it("freezes the exact profile and excludes broad administration", async () => {
    const server = createQ5McpServer(new ScryApiClient("http://scry.invalid/api"));
    const client = new Client({ name: "q5-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name)).toEqual([...Q5_MCP_TOOL_NAMES]);
    expect(tools).toHaveLength(30);
    expect(tools.map(({ name }) => name).join(" ")).not.toMatch(
      /create_project|create_mission|list_missions|create_credential|calibrat|shell|database|direct_http|cdp/i,
    );
    const dispatch = tools.find(({ name }) => name === "dispatch_run_operation")!;
    const dispatchContract = JSON.stringify(dispatch.inputSchema);
    expect(dispatchContract).toContain("semanticEffect");
    expect(dispatchContract).toContain("read_context_transition");
    expect(dispatchContract).toContain("resource_mutation");
    expect(dispatchContract).toContain("unknown");
    expect(
      createHash("sha256")
        .update(JSON.stringify({ profile: Q5_MCP_PROFILE, tools }))
        .digest("hex"),
    ).toBe(Q5_MCP_CONTRACT_DIGEST);
    await client.close();
    await server.close();
  });

  it("publishes the frozen runtime contract summary used by prepaid preflight", async () => {
    await expect(
      inspectQ5McpContract(new ScryApiClient("http://scry.invalid/api")),
    ).resolves.toMatchObject({
      profile: Q5_MCP_PROFILE,
      toolNames: [...Q5_MCP_TOOL_NAMES],
      toolCount: Q5_MCP_TOOL_NAMES.length,
      digest: Q5_MCP_CONTRACT_DIGEST,
    });
  });

  it.each([
    ["alternate Project", `/projects/20000000-0000-4000-8000-000000000001/environments`, undefined],
    ["alternate Mission", `/missions/20000000-0000-4000-8000-000000000002`, undefined],
    ["alternate Objective", `/objectives/20000000-0000-4000-8000-000000000003`, {}],
    ["alternate Run", `/runs/20000000-0000-4000-8000-000000000004`, undefined],
    ["alternate Praxis", `/praxis-sessions/20000000-0000-4000-8000-000000000005`, undefined],
  ])("mechanically refuses %s", async (_name, path, body) => {
    vi.stubGlobal("fetch", vi.fn());
    const client = scoped();
    await expect(body === undefined ? client.get(path) : client.patch(path, body)).rejects.toThrow(
      "Q5_MCP_SCOPE_MISMATCH",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses alternate environment/application/session/campaign/origin in nested input", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = scoped();
    for (const body of [
      { environmentId: "other" },
      { canonicalApplicationId: "other" },
      { agentSessionId: "other" },
      { qualificationCampaignAuthorizationId: "other" },
      { initialProtectedReferenceIds: ["other"] },
      { intent: { action: { protectedReferenceId: "other" } } },
      { nested: { url: "https://evil.example/path" } },
    ])
      await expect(client.post("/projects/operating-context", body)).rejects.toThrow(
        /Q5_MCP_(SCOPE_MISMATCH|ORIGIN_FORBIDDEN)/,
      );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters unrelated historical and credential candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            selection: { projectCandidates: { items: [{ id: scope.projectId }, { id: "other" }] } },
            missions: {
              candidates: { items: [{ id: scope.missionId }, { id: "other" }], truncated: true },
            },
            credentials: { items: [{ id: scope.credentialReferenceIds[0] }, { id: "other" }] },
            environments: { items: [{ id: scope.environmentId }, { id: "other" }] },
          }),
          { status: 200 },
        ),
      ),
    );
    const result: any = await scoped().post("/projects/operating-context", {
      projectId: scope.projectId,
      missionId: scope.missionId,
    });
    expect(result.selection.projectCandidates.items).toEqual([{ id: scope.projectId }]);
    expect(result.missions.candidates.items).toEqual([{ id: scope.missionId }]);
    expect(result.credentials.items).toEqual([{ id: scope.credentialReferenceIds[0] }]);
    expect(result.environments.items).toEqual([{ id: scope.environmentId }]);
  });

  it("projects environment reads to the one canonical environment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [{ id: scope.environmentId }, { id: "other" }],
            environments: [{ id: "other" }, { id: scope.environmentId }],
          }),
          { status: 200 },
        ),
      ),
    );
    const result: any = await scoped().get(`/projects/${scope.projectId}/environments`);
    expect(result.items).toEqual([{ id: scope.environmentId }]);
    expect(result.environments).toEqual([{ id: scope.environmentId }]);
  });
});

function scoped() {
  return new Q5ScopedApiClient(
    "http://scry.invalid/api",
    "internal-service-token",
    "http://scry.invalid/api",
    { provider: "deepseek", externalRunId: scope.externalRunId },
    structuredClone(scope),
    new ScryApiClient("http://scry.invalid/api", "internal-service-token"),
  );
}
