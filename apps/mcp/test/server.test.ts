import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());

describe("Scry MCP server", () => {
  it("initializes with the complete focused tool surface", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "p1", name: "Scry" }]), { status: 200 }),
      ),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "create_project",
      "list_flows",
      "list_environments",
      "create_test_environment",
      "update_test_environment",
      "list_project_credentials",
      "create_project_credential",
      "get_plan_authoring_guide",
      "validate_test_plan",
      "submit_test_spec",
      "revise_flow",
      "replace_flow_steps",
      "extend_flow",
      "start_run",
      "get_run_status",
      "get_test_report",
      "list_failed_steps",
      "list_run_artifacts",
      "get_artifact",
      "rerun_exact_plan",
      "cancel_run",
    ]);
    const response = await client.callTool({ name: "list_projects", arguments: {} });
    expect(response.structuredContent).toEqual({
      projects: [{ id: "p1", name: "Scry" }],
    });

    await client.close();
    await server.close();
  });

  it("revises an existing Flow by appending versions instead of creating a duplicate", async () => {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const specificationId = "11111111-1111-4111-8111-111111111111";
    const specificationVersionId = "22222222-2222-4222-8222-222222222222";
    const planVersionId = "33333333-3333-4333-8333-333333333333";
    const requests: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      const body = method === "GET"
        ? [{ id: specificationId, latestPlan: {
            protocolVersion: "1",
            name: "Login journey",
            objective: "Reach the dashboard.",
            allowedOrigins: ["https://staging.example.com"],
            budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
            steps: [{ id: "open-login", title: "Open login", action: { type: "navigate", url: "/login" } }],
          } }]
        : url.pathname.endsWith("/revisions")
        ? { specificationVersionId, planVersionId, planVersion: 2 }
        : url.pathname.endsWith("/versions") && url.pathname.includes("/specifications/")
        ? { id: specificationVersionId }
        : url.pathname.endsWith("/plans/versions")
          ? { id: planVersionId, version: 2 }
          : { id: specificationId, name: "Login journey" };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "revise_flow",
      arguments: {
        projectId,
        specificationId,
        name: "Login journey",
        description: "Verify login",
        objective: "Reach the dashboard.",
        expectedOutcomes: ["Dashboard is visible"],
        plan: {
          protocolVersion: "1",
          name: "Login journey",
          objective: "Reach the dashboard.",
          allowedOrigins: ["https://staging.example.com"],
          budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
          steps: [{
            id: "open-login",
            title: "Open login",
            action: { type: "navigate", url: "/login" },
          }],
        },
      },
    });

    expect(requests).toEqual([
      { method: "GET", path: `/v1/projects/${projectId}/specifications` },
      { method: "POST", path: `/v1/specifications/${specificationId}/revisions` },
    ]);
    expect(response.structuredContent).toEqual({
      specificationId,
      specificationVersionId,
      planVersionId,
      planVersion: 2,
      preservedStepCount: 1,
      removedStepCount: 0,
    });
    await client.close();
    await server.close();
  });

  it("rejects new Flow creation when existing Flows were not reviewed", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const existingFlowId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: existingFlowId, name: "Sign up and Onboarding" },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "submit_test_spec",
      arguments: {
        projectId,
        reviewedExistingFlowIds: [],
        newFlowJustification: "This is claimed to be a separate user journey for testing.",
        name: "Replacement onboarding flow",
        objective: "Verify onboarding.",
        expectedOutcomes: ["Onboarding completes"],
        plan: {
          protocolVersion: "1",
          name: "Replacement onboarding flow",
          objective: "Verify onboarding.",
          allowedOrigins: ["https://staging.example.com"],
          budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
          steps: [{
            id: "open",
            title: "Open application",
            action: { type: "navigate", url: "/" },
          }],
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it("extends a Flow without losing its existing steps", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const specificationId = "22222222-2222-4222-8222-222222222222";
    const specificationVersionId = "33333333-3333-4333-8333-333333333333";
    const planVersionId = "44444444-4444-4444-8444-444444444444";
    const postedBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(new Response(JSON.stringify([{
          id: specificationId,
          name: "Partner developer journey",
          latestContent: {
            objective: "Sign in and open developer settings.",
            expectedOutcomes: ["Developer settings are visible"],
            preconditions: [],
            prohibitedSideEffects: [],
          },
          latestPlan: {
            protocolVersion: "2",
            name: "Partner developer journey",
            objective: "Sign in and open developer settings.",
            allowedOrigins: ["https://staging.example.com"],
            budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
            steps: [{
              id: "open",
              title: "Open app",
              action: { type: "navigate", url: "/" },
              after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "domStable", quietWindowMs: 500 }] },
            }],
          },
        }]), { status: 200 }));
      }
      postedBodies.push(JSON.parse(String(init?.body)));
      const body = url.pathname.endsWith("/revisions")
        ? { specificationVersionId, planVersionId, planVersion: 2 }
        : { id: planVersionId, version: 2 };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "extend_flow",
      arguments: {
        projectId,
        specificationId,
        objectiveAddition: "Then inspect the API documentation.",
        additionalExpectedOutcomes: ["API documentation is visible"],
        appendedSteps: [{
          id: "open-docs",
          title: "Open documentation",
          action: { type: "click", target: { strategy: "role", role: "link", name: "Documentation" } },
          after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "visible", target: { strategy: "text", value: "API documentation" } }] },
        }],
      },
    });

    expect(response.structuredContent).toMatchObject({
      preservedStepCount: 1,
      appendedStepCount: 1,
      combinedPlan: {
        steps: [
          { id: "open" },
          { id: "open-docs" },
        ],
      },
    });
    expect(postedBodies).toHaveLength(1);
    await client.close();
    await server.close();
  });

  it("replaces only named Flow steps and preserves the rest", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const specificationId = "22222222-2222-4222-8222-222222222222";
    const specificationVersionId = "33333333-3333-4333-8333-333333333333";
    const planVersionId = "44444444-4444-4444-8444-444444444444";
    const latestPlan = {
      protocolVersion: "2",
      name: "Complete login journey",
      objective: "Sign in and reach the dashboard.",
      allowedOrigins: ["https://staging.example.com"],
      budgets: { maxActions: 3, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [
        { id: "open", title: "Open", action: { type: "navigate", url: "/" }, after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "domStable", quietWindowMs: 500 }] } },
        { id: "submit", title: "Submit", action: { type: "click", target: { strategy: "role", role: "button", name: "Login" } }, after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "url", expected: "/dashboard", match: "path" }] } },
        { id: "verify", title: "Verify", action: { type: "waitFor", target: { strategy: "text", value: "Dashboard" }, state: "visible" } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET") return Promise.resolve(new Response(JSON.stringify([{
        id: specificationId,
        name: "Complete login journey",
        latestContent: { objective: latestPlan.objective, expectedOutcomes: ["Dashboard is visible"], preconditions: [], prohibitedSideEffects: [] },
        latestPlan,
      }]), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify(
        url.pathname.endsWith("/revisions")
          ? { specificationVersionId, planVersionId, planVersion: 7 }
          : { id: planVersionId, version: 7 },
      ), { status: 200 }));
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "replace_flow_steps",
      arguments: {
        projectId,
        specificationId,
        replacements: [{
          stepId: "submit",
          reason: "Observed the accessible button name.",
          correctedStep: {
            id: "submit",
            title: "Submit",
            action: { type: "click", target: { strategy: "role", role: "button", name: "Sign in" } },
            after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "url", expected: "/dashboard", match: "path" }] },
          },
        }],
      },
    });
    expect(response.structuredContent).toMatchObject({
      planVersion: 7,
      preservedStepCount: 2,
      replacedStepCount: 1,
      combinedPlan: { steps: [{ id: "open" }, { id: "submit", action: { target: { name: "Sign in" } } }, { id: "verify" }] },
    });
    await client.close();
    await server.close();
  });

  it("rejects a full Flow revision that silently removes existing steps", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const specificationId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: specificationId,
      latestPlan: {
        protocolVersion: "1",
        name: "Complete journey",
        objective: "Complete both checkpoints.",
        allowedOrigins: ["https://staging.example.com"],
        budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
        steps: [
          { id: "open", title: "Open", action: { type: "navigate", url: "/" } },
          { id: "verify", title: "Verify", action: { type: "waitFor", target: { strategy: "text", value: "Complete" }, state: "visible" } },
        ],
      },
    }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "revise_flow",
      arguments: {
        projectId,
        specificationId,
        name: "Complete journey",
        description: "",
        objective: "Complete both checkpoints.",
        expectedOutcomes: ["Journey completes"],
        plan: {
          protocolVersion: "1",
          name: "Complete journey",
          objective: "Complete both checkpoints.",
          allowedOrigins: ["https://staging.example.com"],
          budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
          steps: [{ id: "open", title: "Open", action: { type: "navigate", url: "/" } }],
        },
      },
    });
    expect(response.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it("validates a plan against the selected environment policy", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const environmentId = "22222222-2222-4222-8222-222222222222";
    const origin = "https://staging.example.com";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("/credentials") ? [] : [
        {
          id: environmentId,
          secretRefs: [],
          policy: {
            policyVersion: "1",
            allowedOrigins: [origin],
            allowPrivateNetwork: false,
            allowDownloads: false,
            allowPopups: false,
            maxActions: 10,
            maxDurationMs: 30_000,
            maxNavigations: 2,
          },
        },
      ]), { status: 200 }));
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "validate_test_plan",
      arguments: {
        projectId,
        environmentId,
        plan: {
          protocolVersion: "1",
          name: "Smoke",
          objective: "Verify the home page.",
          allowedOrigins: [origin],
          budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
          steps: [
            {
              id: "home",
              title: "Open home",
              action: { type: "navigate", url: "/" },
            },
          ],
        },
      },
    });
    expect(response.structuredContent).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      violations: [],
    });
    await client.close();
    await server.close();
  });

  it("rejects a plan whose protected credential is unavailable", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const environmentId = "22222222-2222-4222-8222-222222222222";
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const origin = "https://staging.example.com";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(new Response(JSON.stringify({
          valid: false,
          errors: [{ code: "CREDENTIAL_UNAVAILABLE", message: `Protected credential "${credentialId}" is invalid or unavailable for this project.` }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("/credentials") ? [] : [{
        id: environmentId,
        secretRefs: [credentialId],
        policy: {
          policyVersion: "1",
          allowedOrigins: [origin],
          maxActions: 10,
          maxDurationMs: 30_000,
          maxNavigations: 2,
        },
      }]), { status: 200 }));
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createScryMcpServer(new ScryApiClient("http://scry.test/v1"));
    const client = new Client({ name: "scry-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "validate_test_plan",
      arguments: {
        projectId,
        environmentId,
        plan: {
          protocolVersion: "1",
          name: "Authenticated smoke test",
          objective: "Verify authenticated access.",
          allowedOrigins: [origin],
          budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
          steps: [{
            id: "email",
            title: "Enter email",
            action: {
              type: "fill",
              target: { strategy: "placeholder", value: "Email" },
              secretRef: credentialId,
            },
          }],
        },
      },
    });
    expect(response.structuredContent).toEqual({
      valid: false,
      errors: [{
        severity: "error",
        code: "CREDENTIAL_UNAVAILABLE",
        message: `Protected credential "${credentialId}" is invalid or unavailable for this project.`,
        suggestion: "Update the plan or selected environment policy.",
      }],
      warnings: [],
      violations: [{
        code: "CREDENTIAL_UNAVAILABLE",
        message: `Protected credential "${credentialId}" is invalid or unavailable for this project.`,
      }],
    });
    await client.close();
    await server.close();
  });
});
