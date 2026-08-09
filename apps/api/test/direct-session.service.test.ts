import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encryptCredential } from "../src/access/credential.crypto.js";
import { DirectSessionService } from "../src/direct-sessions/direct-session.service.js";

const projectId = randomUUID();
const environmentId = randomUUID();
const emailId = randomUUID();
const passwordId = randomUUID();
const email = "direct-user@example.test";
const password = "direct-secret-value";
let origin = "";
let server: ReturnType<typeof createServer>;

function encrypted(value: string) {
  const result = encryptCredential(value);
  return {
    ciphertext: result.ciphertext.toString("base64"),
    initializationVector: result.initializationVector.toString("base64"),
    authenticationTag: result.authenticationTag.toString("base64"),
  };
}

function database() {
  return {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM environments environment JOIN projects"))
        return { rowCount: 1, rows: [{ baseOrigin: origin, policy: { allowedOrigins: [origin] } }] };
      if (sql.includes("JOIN project_credentials credential")) {
        const id = String(values[2]);
        if (id === emailId) return { rowCount: 1, rows: [encrypted(email)] };
        if (id === passwordId) return { rowCount: 1, rows: [encrypted(password)] };
      }
      return { rowCount: 0, rows: [] };
    },
    transaction: async (work: (client: { query: (sql: string) => Promise<{ rowCount: number }> }) => Promise<unknown>) => work({
      query: async (sql: string) => ({ rowCount: sql.includes("UPDATE environments") ? 1 : 1 }),
    }),
  };
}

const principal = { kind: "service", subject: "scry-service" } as const;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/partner") {
      response.end("<h1>Partner Portal</h1><a href='/developer'>Developer</a>");
      return;
    }
    if (request.url === "/developer") {
      response.end("<h1>Developer</h1><button>Test Mode</button><button>Duplicate</button><button>Duplicate</button><button id=generate>Generate</button><a href='https://example.com'>Leave</a><section><h2>Create Order</h2><label>Client ID<input></label><button id=run-order>Run POST</button><p aria-live=polite>Waiting</p><pre class=try-result hidden>{\"clientSecret\":\"must-not-leak\"}</pre></section><section><h2>List Orders</h2><label>Client ID<input></label><button>Run</button></section><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<p>Ready later</p>'),250);document.querySelector('#generate').onclick=()=>document.body.insertAdjacentHTML('beforeend','<input data-credential-field=client-secret value=generated-secret>');document.querySelector('#run-order').onclick=()=>setTimeout(()=>{document.querySelector('[aria-live]').textContent='201 Created';document.querySelector('.try-result').hidden=false},50)</script>");
      return;
    }
    response.end(`<h1>Sign in</h1><label>Email<input></label><label>Password<input type=password></label><button id=login>Sign in</button><script>document.querySelector('#login').onclick=()=>location.href='/partner'</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture unavailable");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { process.env.SCRY_DIRECT_BROWSER_ENABLED = "true"; });

describe("DirectSessionService", () => {
  it("completes login with encrypted credential references and emits no secret bytes", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [
        { type: "fillCredential", target: { strategy: "label", value: "Email", exact: true }, credentialId: emailId },
        { type: "fillCredential", target: { strategy: "label", value: "Password", exact: true }, credentialId: passwordId },
        { type: "click", target: { strategy: "role", role: "button", name: "Sign in", exact: true } },
        { type: "waitForUrl", value: "/partner", match: "path" },
      ], timeoutMs: 20_000,
    });
    expect(turn.results).toHaveLength(4);
    expect(turn.results.every((result) => result.status === "succeeded")).toBe(true);
    expect(turn.observation).toMatchObject({ url: `${origin}/partner` });
    const closed = await service.close(principal, started.sessionId);
    const bytes = JSON.stringify({ started, turn, closed });
    expect(bytes).not.toContain(email);
    expect(bytes).not.toContain(password);
    expect(closed).toMatchObject({ transcriptEntryCount: 4, transcriptTruncated: false });
    await service.onModuleDestroy();
  }, 30_000);

  it("rejects an unapproved origin before dispatch", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [{ type: "navigate", url: "https://example.com" }], timeoutMs: 5_000,
    });
    expect(turn).toMatchObject({ state: "closed", observation: null });
    expect(turn.results[0]).toMatchObject({ status: "failed", dispatchState: "not_started", reasonCode: "DIRECT_ORIGIN_NOT_ALLOWED" });
    await service.onModuleDestroy();
  }, 20_000);

  it("destroys the session when a dispatched action escapes the origin allowlist", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, startUrl: `${origin}/developer`, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [{ type: "click", target: { strategy: "role", role: "link", name: "Leave", exact: true } }], timeoutMs: 10_000,
    });
    expect(turn).toMatchObject({ state: "closed", observation: null });
    expect(turn.results[0]).toMatchObject({ status: "failed", dispatchState: "dispatched", reasonCode: "DIRECT_ORIGIN_NOT_ALLOWED" });
    await expect(service.observe(principal, started.sessionId)).rejects.toMatchObject({ response: { code: "DIRECT_SESSION_NOT_FOUND" } });
    await service.onModuleDestroy();
  }, 20_000);

  it("reports ambiguous targets without dispatching", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, startUrl: `${origin}/developer`, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [{ type: "click", target: { strategy: "role", role: "button", name: "Duplicate", exact: true } }], timeoutMs: 5_000,
    });
    expect(turn.results[0]).toMatchObject({ status: "failed", dispatchState: "not_started", reasonCode: "DIRECT_TARGET_AMBIGUOUS" });
    await service.close(principal, started.sessionId);
    await service.onModuleDestroy();
  }, 20_000);

  it("waits for a target that is not present when the turn begins", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, startUrl: `${origin}/developer`, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [{ type: "waitForElement", target: { strategy: "text", value: "Ready later", exact: true }, state: "visible", timeoutMs: 2_000 }],
      timeoutMs: 5_000,
    });
    expect(turn.results[0]).toMatchObject({ status: "succeeded", dispatchState: "not_started" });
    await service.close(principal, started.sessionId);
    await service.onModuleDestroy();
  }, 20_000);

  it("is unavailable when its feature flag is disabled", async () => {
    process.env.SCRY_DIRECT_BROWSER_ENABLED = "false";
    const service = new DirectSessionService(database() as never);
    await expect(service.start(principal, { projectId, environmentId, additionalOrigins: [] })).rejects.toMatchObject({ response: { code: "DIRECT_BROWSER_DISABLED" } });
    await service.onModuleDestroy();
  });

  it("captures a generated credential atomically without returning its value", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, startUrl: `${origin}/developer`, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [{
        type: "clickAndCaptureCredential",
        target: { strategy: "role", role: "button", name: "Generate", exact: true },
        captureTarget: { strategy: "credentialField", value: "client-secret" },
        credentialName: "captured-test-credential",
      }],
      timeoutMs: 5_000,
    });
    expect(turn.results[0]).toMatchObject({ status: "succeeded", dispatchState: "dispatched" });
    expect(turn.results[0]).toHaveProperty("credentialId");
    expect(JSON.stringify(turn)).not.toContain("generated-secret");
    await service.close(principal, started.sessionId);
    await service.onModuleDestroy();
  }, 20_000);

  it("scopes repeated controls to a semantic section and redacts inspected content", async () => {
    const service = new DirectSessionService(database() as never);
    const started = await service.start(principal, { projectId, environmentId, startUrl: `${origin}/developer`, additionalOrigins: [] });
    const turn = await service.turn(principal, started.sessionId, {
      actions: [
        { type: "fillPublic", target: { strategy: "sectionLabel", sectionHeading: "Create Order", value: "Client ID", exact: true }, value: "public-client-id" },
        { type: "click", target: { strategy: "sectionRole", sectionHeading: "Create Order", role: "button", name: "Run POST", exact: true } },
        { type: "waitForText", target: { strategy: "sectionLiveRegion", sectionHeading: "Create Order" }, value: "201 Created", match: "exact", timeoutMs: 1_000 },
        { type: "inspectTarget", target: { strategy: "sectionResponse", sectionHeading: "Create Order" }, maxCharacters: 1_000 },
      ],
      timeoutMs: 5_000,
    });
    expect(turn.results.every((result) => result.status === "succeeded")).toBe(true);
    expect(turn.results[3]).toMatchObject({ content: expect.stringContaining('"clientSecret":"[REDACTED]') });
    expect(JSON.stringify(turn)).not.toContain("must-not-leak");
    await service.close(principal, started.sessionId);
    await service.onModuleDestroy();
  }, 20_000);
});
