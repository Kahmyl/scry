import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  executionPolicyV1Schema,
  testPlanV1Schema,
  testPlanV2Schema,
} from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";

import {
  executePlan,
  type HumanInteractionController,
  type HumanInteractionHandle,
  type HumanInteractionRequest,
} from "../src/index.js";

let server: Server;
let origin: string;
let humanAuthenticated = false;
let humanHandoffActive = false;
const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chromium";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/redirect-external") {
      response.writeHead(302, { location: "https://example.com/blocked" });
      response.end();
      return;
    }
    if (request.url === "/redirect-login") {
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }
    if (request.url === "/login") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Sign in</h1>");
      return;
    }
    if (request.url === "/interactive-login") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><h1>Sign in</h1><script>
        const poll = setInterval(async () => {
          const state = await fetch('/human-auth-state').then((response) => response.json());
          if (state.handoffActive) {
            console.log(state.protectedConsole);
            await fetch('/protected-poll?credential=' + encodeURIComponent(state.credential));
          }
          if (state.authenticated) {
            clearInterval(poll);
            history.replaceState({}, '', '/dashboard');
            document.body.innerHTML = '<h1>Dashboard</h1>';
          }
        }, 40);
      </script>`);
      return;
    }
    if (request.url === "/human-auth-state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        authenticated: humanAuthenticated,
        handoffActive: humanHandoffActive,
        ...(humanHandoffActive ? {
          credential: "protected-human-secret",
          protectedConsole: "protected-human-console",
        } : {}),
      }));
      return;
    }
    if (request.url === "/start-human-handoff") {
      humanHandoffActive = true;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/complete-human-auth") {
      humanAuthenticated = true;
      humanHandoffActive = false;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url?.startsWith("/protected-poll")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("protected-human-secret");
      return;
    }
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=blocked.txt",
      });
      response.end("blocked");
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Popup</h1>");
      return;
    }
    if (request.url === "/success") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Welcome aboard</h1>");
      return;
    }
    if (request.url === "/optional-subresource") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<h1>Application loaded</h1><img src="https://assets.example.test/optional.png" alt=""><iframe src="https://example.com/embedded"></iframe>',
      );
      return;
    }
    if (request.url === "/empty-spa") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<title>Empty shell</title><div id="root"></div>');
      return;
    }
    if (request.url === "/loading-spa") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<title>Loading shell</title><div id="root">Loading...</div>');
      return;
    }
    if (request.url === "/delayed-docs") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <button onclick="setTimeout(() => {
          document.querySelector('#docs-root').innerHTML = '<section><button>Run POST</button></section>'
        }, 1500)">Create Order</button>
        <div id="docs-root"></div>`);
      return;
    }
    if (request.url === "/ambiguous-applications") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<a href="/success">Applications</a><span>Applications</span>');
      return;
    }
    if (request.url === "/generated-secret") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<label>Client secret <input value="generated-secret-value"></label><label>API secret <input></label><script>console.log("generated-secret-value");fetch("/leaky-diagnostic?value=generated-secret-value")</script>');
      return;
    }
    if (request.url?.startsWith("/leaky-diagnostic")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "generated-secret-value" }));
      return;
    }
    if (request.url === "/api-error") {
      response.writeHead(400, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ code: "INVALID_OWNER", detail: "Rejected super-secret-value" }));
      return;
    }
    if (request.url === "/error-console") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<label>API secret <input></label><button onclick="fetch(\'/api-error\')">Run POST</button>');
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <label>Email <input aria-label="Email" oninput="console.log(this.value)"></label>
      <button onclick="location.href='/success'">Create account</button>
      <button onclick="window.open('/popup')">Open popup</button>
      <a href="/download" download>Download file</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

class TestHumanController implements HumanInteractionController {
  readonly requests: HumanInteractionRequest[] = [];
  readonly outcomes: string[] = [];
  rejectionCount = 0;
  private takeover: { instructions: string } | undefined;

  constructor(private readonly rejectFirstReturn = false, private readonly returnDelayMs = 0) {}

  requestTakeover(instructions = "Inspect the page") {
    this.takeover = { instructions };
  }

  consumeTakeoverRequest() {
    const request = this.takeover;
    this.takeover = undefined;
    return request;
  }

  async open(request: HumanInteractionRequest): Promise<HumanInteractionHandle> {
    this.requests.push(request);
    await fetch(`${origin}/start-human-handoff`);
    let commands = 0;
    return {
      nextCommand: async () => {
        commands += 1;
        if (this.returnDelayMs) await new Promise((resolve) => setTimeout(resolve, this.returnDelayMs));
        if (!this.rejectFirstReturn || commands > 1) {
          await fetch(`${origin}/complete-human-auth`);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return { type: "return_control" };
      },
      returnRejected: () => {
        this.rejectionCount += 1;
      },
      close: (outcome) => {
        this.outcomes.push(outcome);
      },
    };
  }
}

describe("executePlan", () => {
  it("allows a navigation to finish on a permitted same-origin redirect", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-redirect-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Redirect to login",
      objective: "Open an application that redirects signed-out users.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 2 },
      steps: [
        {
          id: "step-1-navigate",
          title: "Open application",
          action: { type: "navigate", url: "/redirect-login" },
          assertions: [{ type: "url", expected: "/redirect-login", match: "path" }],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 20_000,
      maxNavigations: 2,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("passed");
    expect(report.steps[0]?.status).toBe("passed");
    expect(report.requiredAssertions).toEqual({ passed: 0, failed: 0, unevaluated: 0 });
  }, 30_000);

  it("continues to enforce explicit URL proof on generated navigation steps", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-explicit-url-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Explicit redirect proof",
      objective: "Prove that user-authored URL checks remain enforced.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 2 },
      steps: [
        {
          id: "step-1-navigate",
          title: "Open application",
          action: { type: "navigate", url: "/redirect-login" },
          assertions: [{ type: "url", expected: "/dashboard", match: "contains" }],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 20_000,
      maxNavigations: 2,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(report.requiredAssertions).toEqual({ passed: 0, failed: 1, unevaluated: 0 });
  }, 30_000);

  it("executes a real browser journey and writes a passing report", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-executor-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Local signup",
      objective: "Verify the local signup path.",
      allowedOrigins: [origin],
      budgets: { maxActions: 10, maxDurationMs: 20_000, maxNavigations: 2 },
      steps: [
        {
          id: "open",
          title: "Open signup",
          action: { type: "navigate", url: "/" },
        },
        {
          id: "email",
          title: "Enter email",
          action: {
            type: "fill",
            target: { strategy: "label", value: "Email" },
            secretRef: "11111111-1111-4111-8111-111111111111",
          },
        },
        {
          id: "submit",
          title: "Submit signup",
          action: {
            type: "click",
            target: { strategy: "role", role: "button", name: "Create account" },
          },
          assertions: [
            { type: "url", expected: "/success", match: "path" },
            {
              type: "text",
              target: { strategy: "role", role: "heading", name: "Welcome aboard" },
              expected: "Welcome aboard",
            },
          ],
          evidence: ["screenshot", "dom"],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 10,
      maxDurationMs: 20_000,
      maxNavigations: 2,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
      secretResolver: async () => "test@example.invalid",
    });

    expect(report.state).toBe("passed");
    expect(report.requiredAssertions).toEqual({ passed: 2, failed: 0, unevaluated: 0 });
    expect(report.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    expect(report.artifacts.find((artifact) => artifact.kind === "screenshot")?.observation)
      .toMatchObject({ visualRedaction: "protected-elements-masked" });
    expect(report.artifacts.find((artifact) => artifact.kind === "video")?.observation)
      .toMatchObject({ visualRedaction: "protected-elements-masked" });
    expect(await readFile(path.join(outputDirectory, "attempt.json"), "utf8")).not.toContain(
      "test@example.invalid",
    );
  }, 30_000);

  it("records a product failure with evidence instead of an infrastructure error", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-failure-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Expected failure",
      objective: "Prove assertion failures remain product failures.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "missing-heading",
          title: "Check a missing heading",
          action: { type: "navigate", url: "/" },
          assertions: [
            {
              type: "visible",
              target: { strategy: "role", role: "heading", name: "Does not exist" },
              timeoutMs: 250,
            },
          ],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(report.requiredAssertions).toEqual({ passed: 0, failed: 1, unevaluated: 0 });
    expect(report.steps[0]?.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(
      true,
    );
    expect(report.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(true);
  }, 30_000);

  it("allows a public page dependency without widening document navigation", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-subresource-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Optional subresource",
      objective: "Keep an allowed document usable when an optional asset is blocked.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open application",
          action: { type: "navigate", url: "/optional-subresource" },
          assertions: [
            {
              type: "visible",
              target: { strategy: "role", role: "heading", name: "Application loaded" },
            },
          ],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 1,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("passed");
    expect(report.requiredAssertions).toEqual({ passed: 1, failed: 0, unevaluated: 0 });
    expect(report.policyViolations).toEqual([]);
  }, 30_000);

  it("does not pass a navigation when the application mount remains empty", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-empty-shell-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Empty application shell",
      objective: "Do not confuse an HTTP response with a rendered application.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open application",
          action: { type: "navigate", url: "/empty-spa", timeoutMs: 300 },
          assertions: [{ type: "url", expected: "/empty-spa", match: "path" }],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 1,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(report.steps[0]?.error).toContain("application did not render");
    expect(report.requiredAssertions).toEqual({ passed: 0, failed: 0, unevaluated: 1 });
  }, 30_000);

  it("does not pass a navigation while the application remains on a loading placeholder", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-loading-shell-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Loading application shell",
      objective: "Wait for application content rather than a loading placeholder.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open application",
          action: { type: "navigate", url: "/loading-spa", timeoutMs: 300 },
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 1,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(report.steps[0]?.error).toContain("remained in its loading state");
  }, 30_000);

  it("blocks redirects, popups, and downloads with auditable policy events", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-policy-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Adversarial capabilities",
      objective: "Verify forbidden browser capabilities are blocked.",
      allowedOrigins: [origin],
      budgets: { maxActions: 4, maxDurationMs: 20_000, maxNavigations: 2 },
      steps: [
        {
          id: "open",
          title: "Open fixture",
          action: { type: "navigate", url: "/" },
        },
        {
          id: "popup",
          title: "Attempt popup",
          action: {
            type: "click",
            target: { strategy: "role", role: "button", name: "Open popup" },
          },
          onFailure: "continue",
        },
        {
          id: "download",
          title: "Attempt download",
          action: {
            type: "click",
            target: { strategy: "role", role: "link", name: "Download file" },
          },
          onFailure: "continue",
        },
        {
          id: "redirect",
          title: "Attempt external redirect",
          action: { type: "navigate", url: "/redirect-external" },
          onFailure: "continue",
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 4,
      maxDurationMs: 20_000,
      maxNavigations: 2,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(
      report.policyViolations.map((violation) => violation.code),
      JSON.stringify(report.steps),
    ).toEqual(
      expect.arrayContaining([
        "POPUP_NOT_ALLOWED",
        "DOWNLOAD_NOT_ALLOWED",
        "ORIGIN_NOT_ALLOWED",
      ]),
    );
    const events = await readFile(path.join(outputDirectory, "events.jsonl"), "utf8");
    expect(events.match(/policy\.rejected/g)).toHaveLength(3);
  }, 30_000);

  it("redacts resolved secrets from reports, events, DOM, and network evidence", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-redaction-"));
    const secret = "a+b@example.invalid";
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Secret redaction",
      objective: "Verify secret values are not persisted in textual evidence.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        { id: "open", title: "Open fixture", action: { type: "navigate", url: "/" } },
        {
          id: "secret",
          title: "Enter secret",
          action: {
            type: "fill",
            target: { strategy: "label", value: "Email" },
            secretRef: "11111111-1111-4111-8111-111111111111",
          },
          evidence: ["dom", "network"],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
      secretResolver: async () => secret,
    });

    expect(report.state).toBe("passed");
    const persistedText = (
      await Promise.all([
        readFile(path.join(outputDirectory, "attempt.json"), "utf8"),
        readFile(path.join(outputDirectory, "events.jsonl"), "utf8"),
        readFile(path.join(outputDirectory, "dom", "secret.html"), "utf8"),
        readFile(path.join(outputDirectory, "network", "secret.json"), "utf8"),
      ])
    ).join("\n");
    expect(persistedText).not.toContain(secret);
    expect(persistedText).toContain("[REDACTED]");
    expect(report.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(true);
  }, 30_000);

  it("rejects an allowed-origin URL when it resolves to a private destination", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-private-"));
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Private network rejection",
      objective: "Verify origin permission does not imply private-network permission.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "private",
          title: "Attempt private destination",
          action: { type: "navigate", url: "/" },
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: false,
      maxActions: 1,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
    });

    expect(report.state).toBe("failed");
    expect(report.policyViolations.map((violation) => violation.code)).toContain(
      "PRIVATE_NETWORK_NOT_ALLOWED",
    );
  }, 30_000);

  it("waits for delayed SPA content before capturing conclusive v2 evidence", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-v2-delayed-docs-"));
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Delayed documentation rendering",
      objective: "Wait for the Create Order operation before recording evidence.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 1 },
      steps: [
        {
          id: "open-docs",
          title: "Open documentation",
          action: { type: "navigate", url: "/delayed-docs" },
          after: {
            mode: "all",
            timeoutMs: 5_000,
            conditions: [{ type: "visible", target: { strategy: "role", role: "button", name: "Create Order" } }],
          },
          assertions: [],
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-create-order",
          title: "Open Create Order",
          action: { type: "click", target: { strategy: "role", role: "button", name: "Create Order" } },
          after: {
            mode: "all",
            timeoutMs: 5_000,
            conditions: [
              { type: "visible", target: { strategy: "text", value: "Run POST" } },
              { type: "content", target: { strategy: "css", value: "#docs-root", justification: "Documentation mount point" }, minimumChildren: 1 },
            ],
          },
          assertions: [{ type: "visible", target: { strategy: "text", value: "Run POST" } }],
          evidence: ["screenshot", "dom"],
          captureIntent: "final",
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 20_000,
      maxNavigations: 1,
    });

    const startedAt = Date.now();
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel });

    expect(report.state).toBe("passed");
    expect(report.outcomeClassification).toBe("passed");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(report.steps[1]?.readiness).toMatchObject({ status: "passed" });
    expect(report.artifacts.find((artifact) => artifact.kind === "screenshot")?.observation)
      .toMatchObject({ captureIntent: "final", readiness: { status: "passed" } });
  }, 30_000);

  it("classifies a v2 readiness timeout separately from a product failure", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-v2-readiness-timeout-"));
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Missing delayed content",
      objective: "Observe a bounded readiness timeout.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [{
        id: "open",
        title: "Open empty shell",
        action: { type: "navigate", url: "/empty-spa" },
        after: {
          mode: "all",
          timeoutMs: 500,
          conditions: [{ type: "content", target: { strategy: "css", value: "#root", justification: "Application mount point" }, minimumChildren: 1 }],
        },
        assertions: [],
        evidence: ["screenshot"],
        captureIntent: "final",
      }],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 1,
      maxDurationMs: 10_000,
      maxNavigations: 1,
    });

    const report = await executePlan({ plan, policy, outputDirectory, browserChannel });
    expect(report.state).toBe("failed");
    expect(report.outcomeClassification).toBe("readiness_timeout");
    expect(report.steps[0]?.readiness?.status).toBe("failed");
  }, 30_000);

  it("classifies an ambiguous semantic target as an inconclusive plan", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-ambiguous-target-"));
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Ambiguous application target",
      objective: "Reject a target that cannot identify one element.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open applications",
          action: { type: "navigate", url: "/ambiguous-applications" },
          after: { mode: "all", timeoutMs: 2_000, conditions: [{ type: "domStable", quietWindowMs: 100 }] },
          assertions: [],
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "select-applications",
          title: "Select Applications",
          action: { type: "waitFor", target: { strategy: "text", value: "Applications", exact: true }, state: "visible" },
          assertions: [],
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 10_000,
      maxNavigations: 1,
    });

    const report = await executePlan({ plan, policy, outputDirectory, browserChannel });
    expect(report.state).toBe("failed");
    expect(report.outcomeClassification).toBe("inconclusive_plan");
    expect(report.steps[1]?.error).toContain("matched 2 elements");
    expect(report.steps[1]?.error).toContain("Use a role");
  }, 30_000);

  it("classifies an interaction locator timeout as an inconclusive plan, not an assertion failure", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-missing-action-target-"));
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Missing submit control",
      objective: "Do not confuse an unexecutable locator with a failed expectation.",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 5_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open form",
          action: { type: "navigate", url: "/" },
          after: { mode: "all", timeoutMs: 500, conditions: [{ type: "visible", target: { strategy: "role", role: "button", name: "Create account" } }] },
          assertions: [],
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "submit",
          title: "Submit missing form",
          action: { type: "waitFor", target: { strategy: "css", value: "form button[type='submit']", justification: "Intentionally missing fixture target" }, state: "visible", timeoutMs: 300 },
          assertions: [],
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 2,
      maxDurationMs: 5_000,
      maxNavigations: 1,
    });

    const report = await executePlan({ plan, policy, outputDirectory, browserChannel });
    expect(report.state).toBe("failed");
    expect(report.outcomeClassification).toBe("inconclusive_plan");
    expect(report.steps[1]?.assertions).toHaveLength(0);
  }, 10_000);

  it("captures a generated secret without persisting it in evidence and reuses it in memory", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-captured-secret-"));
    let stored: { name: string; value: string } | undefined;
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Capture generated secret",
      objective: "Protect a one-time generated value.",
      allowedOrigins: [origin],
      budgets: { maxActions: 3, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [
        { id: "open", title: "Open", action: { type: "navigate", url: "/generated-secret" }, after: { mode: "all", timeoutMs: 2_000, conditions: [{ type: "visible", target: { strategy: "label", value: "Client secret" } }] } },
        { id: "capture", title: "Protect secret", action: { type: "captureSecret", target: { strategy: "label", value: "Client secret" }, reference: "api_secret", credentialName: "Generated API secret" } },
        { id: "reuse", title: "Reuse secret", action: { type: "fill", target: { strategy: "label", value: "API secret" }, capturedSecretRef: "api_secret" }, evidence: ["dom", "network", "screenshot"] },
      ],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 3, maxDurationMs: 10_000, maxNavigations: 1 });
    const report = await executePlan({
      plan,
      policy,
      outputDirectory,
      browserChannel,
      secretCapture: async (name, value) => {
        stored = { name, value };
        return { credentialId: "11111111-1111-4111-8111-111111111111" };
      },
    });
    expect(report.state).toBe("passed");
    expect(stored).toEqual({ name: "Generated API secret", value: "generated-secret-value" });
    expect(report.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    expect(report.artifacts.find((artifact) => artifact.kind === "screenshot")?.observation)
      .toMatchObject({ visualRedaction: "protected-elements-masked" });
    expect(await readFile(path.join(outputDirectory, "attempt.json"), "utf8")).not.toContain("generated-secret-value");
    expect(await readFile(path.join(outputDirectory, "events.jsonl"), "utf8")).not.toContain("generated-secret-value");
    expect(await readFile(path.join(outputDirectory, "network", "reuse.json"), "utf8")).not.toContain("generated-secret-value");
    const redactedDom = await readFile(path.join(outputDirectory, "dom", "reuse.html"), "utf8");
    expect(redactedDom).not.toContain("generated-secret-value");
    expect(redactedDom).toContain("data-scry-redacted=\"true\"");
    expect(redactedDom).toContain("background: rgb(0, 0, 0) !important");
    expect(redactedDom).toContain("-webkit-text-fill-color: transparent !important");
  }, 30_000);

  it("captures bounded redacted JSON error bodies in network evidence", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-network-error-body-"));
    const secret = "super-secret-value";
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Inspect safe API error",
      objective: "Record a structured API failure without leaking credentials.",
      allowedOrigins: [origin],
      budgets: { maxActions: 3, maxDurationMs: 10_000, maxNavigations: 1 },
      steps: [
        { id: "open", title: "Open console", action: { type: "navigate", url: "/error-console" }, after: { mode: "all", timeoutMs: 1_000, conditions: [{ type: "visible", target: { strategy: "role", role: "button", name: "Run POST" } }] } },
        { id: "secret", title: "Enter secret", action: { type: "fill", target: { strategy: "label", value: "API secret" }, secretRef: "11111111-1111-4111-8111-111111111111" } },
        {
          id: "run",
          title: "Run request",
          action: { type: "click", target: { strategy: "role", role: "button", name: "Run POST" } },
          after: { mode: "all", timeoutMs: 2_000, conditions: [{ type: "request", urlPattern: "/api-error", method: "GET", status: { min: 400, max: 499 } }] },
          evidence: ["network"],
          captureIntent: "transient",
          transientJustification: "Capture the redacted API error response.",
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 3, maxDurationMs: 10_000, maxNavigations: 1 });
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel, secretResolver: async () => secret });
    expect(report.state).toBe("passed");
    const evidence = await readFile(path.join(outputDirectory, "network", "run.json"), "utf8");
    expect(evidence).toContain("INVALID_OWNER");
    expect(evidence).toContain("[REDACTED]");
    expect(evidence).not.toContain(secret);
    expect(report.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(true);
    expect(report.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(false);
  }, 30_000);

  it("pauses for planned human interaction, rejects an early return, and resumes with segmented evidence", async () => {
    humanAuthenticated = false;
    humanHandoffActive = false;
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-human-handoff-"));
    const controller = new TestHumanController(true);
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Interactive sign in",
      objective: "Let a customer sign in without exposing credentials.",
      allowedOrigins: [origin],
      budgets: { maxActions: 3, maxDurationMs: 5_000, maxNavigations: 1 },
      steps: [
        {
          id: "open",
          title: "Open sign in",
          action: { type: "navigate", url: "/interactive-login" },
          after: { conditions: [{ type: "visible", target: { strategy: "role", role: "heading", name: "Sign in" } }] },
        },
        {
          id: "human-login",
          title: "Complete sign in",
          action: {
            type: "requestUserInteraction",
            reason: "login",
            instructions: "Sign in and complete MFA.",
            timeoutMs: 4_000,
            resumeWhen: { timeoutMs: 200, conditions: [{ type: "url", expected: "/dashboard", match: "path" }] },
          },
        },
        {
          id: "verify",
          title: "Verify dashboard",
          action: { type: "waitFor", target: { strategy: "role", role: "heading", name: "Dashboard" }, state: "visible" },
          assertions: [{ type: "visible", target: { strategy: "role", role: "heading", name: "Dashboard" } }],
          evidence: ["dom", "network", "screenshot"],
        },
      ],
    });
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
      maxActions: 3,
      maxDurationMs: 5_000,
      maxNavigations: 1,
    });

    const report = await executePlan({ plan, policy, outputDirectory, browserChannel, humanInteractionController: controller });

    expect(report.state).toBe("passed");
    expect(controller.rejectionCount).toBe(1);
    expect(controller.outcomes).toEqual(["completed"]);
    expect(report.artifacts.filter((artifact) => artifact.kind === "trace")).toHaveLength(2);
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(false);
    const events = await readFile(path.join(outputDirectory, "events.jsonl"), "utf8");
    expect(events).toContain("interaction.return_rejected");
    expect(events).toContain("evidence.suspended");
    expect(events).toContain("evidence.resumed");
    const persistedEvidence = [
      await readFile(path.join(outputDirectory, "attempt.json"), "utf8"),
      events,
      await readFile(path.join(outputDirectory, "dom", "verify.html"), "utf8"),
      await readFile(path.join(outputDirectory, "network", "verify.json"), "utf8"),
    ].join("\n");
    expect(persistedEvidence).not.toContain("protected-human-secret");
    expect(persistedEvidence).not.toContain("protected-human-console");
    for (const artifact of report.artifacts.filter((item) => item.kind === "trace")) {
      const archive = unzipSync(await readFile(path.join(outputDirectory, artifact.relativePath!)));
      const traceText = Object.values(archive).map((value) => Buffer.from(value).toString("utf8")).join("\n");
      expect(traceText).not.toContain("protected-human-secret");
      expect(traceText).not.toContain("protected-human-console");
    }
  }, 30_000);

  it("classifies an explicit handoff without a controller as infrastructure failure", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-human-unavailable-"));
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Unavailable handoff",
      objective: "Fail safely without a controller.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
      steps: [{
        id: "human-login",
        title: "Complete sign in",
        action: {
          type: "requestUserInteraction",
          reason: "login",
          instructions: "Sign in.",
          resumeWhen: { conditions: [{ type: "url", expected: "/dashboard", match: "path" }] },
        },
      }],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 });
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel });
    expect(report.state).toBe("infrastructure_error");
    expect(report.error).toContain("no controller is configured");
  }, 30_000);

  it("honors a queued user takeover and excludes human wait from the active run budget", async () => {
    humanAuthenticated = false;
    humanHandoffActive = false;
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-user-takeover-"));
    const controller = new TestHumanController(false, 1_200);
    controller.requestTakeover();
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Voluntary takeover",
      objective: "Pause at a safe action boundary.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 },
      steps: [{ id: "open", title: "Open", action: { type: "navigate", url: "/success" }, assertions: [{ type: "visible", target: { strategy: "role", role: "heading", name: "Welcome aboard" } }] }],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 });
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel, humanInteractionController: controller });
    expect(report.state).toBe("passed");
    expect(report.durationMs).toBeGreaterThanOrEqual(1_200);
    expect(controller.requests[0]?.kind).toBe("takeover");
    expect(report.artifacts.some((artifact) => artifact.kind === "video")).toBe(false);
  }, 30_000);

  it("expires a human interaction on its separate deadline", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-human-expiry-"));
    const controller: HumanInteractionController = {
      consumeTakeoverRequest: () => undefined,
      open: async () => ({
        nextCommand: (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      }),
    };
    const plan = testPlanV2Schema.parse({
      protocolVersion: "2",
      name: "Expiring handoff",
      objective: "Bound abandoned human interaction.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
      steps: [{
        id: "human",
        title: "Wait for user",
        action: {
          type: "requestUserInteraction",
          reason: "other",
          instructions: "Review the page.",
          timeoutMs: 1_000,
          resumeWhen: { conditions: [{ type: "url", expected: "/", match: "path" }] },
        },
      }],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 });
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel, humanInteractionController: controller });
    expect(report.state).toBe("timed_out");
    expect(await readFile(path.join(outputDirectory, "events.jsonl"), "utf8")).toContain("interaction.expired");
  }, 30_000);

  it("cancels the run when the human controller cancels the interaction", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-human-cancel-"));
    const controller: HumanInteractionController = {
      consumeTakeoverRequest: () => ({ instructions: "Take control" }),
      open: async () => ({ nextCommand: async () => ({ type: "cancel", reason: "Customer stopped the session" }) }),
    };
    const plan = testPlanV1Schema.parse({
      protocolVersion: "1",
      name: "Cancelled takeover",
      objective: "Allow the customer to stop safely.",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
      steps: [{ id: "open", title: "Open", action: { type: "navigate", url: "/success" } }],
    });
    const policy = executionPolicyV1Schema.parse({ policyVersion: "1", allowedOrigins: [origin], allowPrivateNetwork: true, maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 });
    const report = await executePlan({ plan, policy, outputDirectory, browserChannel, humanInteractionController: controller });
    expect(report.state).toBe("cancelled");
    expect(report.error).toContain("Customer stopped the session");
  }, 30_000);
});
