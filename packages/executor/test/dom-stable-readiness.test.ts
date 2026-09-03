import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";

import { executePlan } from "../src/executor.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ),
);

describe("DOM-stable readiness", () => {
  it("waits outside the browser evaluation realm without injected helper references", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<main>ready</main>");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const plan = currentPlanSchema.parse({
      name: "DOM stable",
      objective: "Verify readiness",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open",
          action: { type: "navigate", url: origin },
          after: {
            mode: "all",
            timeoutMs: 5_000,
            conditions: [{ type: "domStable", quietWindowMs: 200 }],
          },
          assertions: [{ type: "url", expected: "/", match: "path" }],
          evidence: [],
          onFailure: "stop",
          captureIntent: "final",
        },
      ],
    });
    const captureSuccessorCheckpoint = vi.fn();
    const report = await executePlan({
      plan,
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: await mkdtemp(path.join(tmpdir(), "scry-dom-stable-")),
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      captureSuccessorCheckpoint,
    });
    expect(report.state).toBe("passed");
    expect(report.steps[0]?.readiness).toMatchObject({ status: "passed" });
    expect(captureSuccessorCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        restorationUrl: `${origin}/`,
        storageState: expect.objectContaining({
          cookies: expect.any(Array),
          origins: expect.any(Array),
        }),
        sessionStorage: { origin, entries: [] },
      }),
    );
  }, 15_000);

  it("fails the Run closed when the durable successor checkpoint cannot be staged", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<main>ready</main>");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const plan = currentPlanSchema.parse({
      name: "Checkpoint failure",
      objective: "Fail closed",
      allowedOrigins: [origin],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open",
          action: { type: "navigate", url: origin },
          assertions: [],
          evidence: [],
          onFailure: "stop",
          captureIntent: "transient",
        },
      ],
    });
    const report = await executePlan({
      plan,
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: await mkdtemp(path.join(tmpdir(), "scry-checkpoint-failure-")),
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      captureSuccessorCheckpoint: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(report).toMatchObject({
      state: "infrastructure_error",
      error: "SUCCESSOR_CHECKPOINT_ESTABLISHMENT_FAILED",
    });
  }, 15_000);

  it("keeps post-action readiness independent after the pre-dispatch deadline expires", async () => {
    const actionTimeoutMs = 1_000;
    const readinessDelayMs = 1_300;
    const readinessTimeoutMs = 2_500;
    let dispatchCount = 0;
    let dispatchAt = 0;
    let actionStartedAt = 0;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<main>
        <button>Start</button><section aria-label="Result">Waiting</section>
        <script>
          document.querySelector('button').addEventListener('click', () => {
            setTimeout(() => {
              document.querySelector('section').textContent = 'Ready after action deadline';
            }, ${readinessDelayMs});
          });
        </script>
      </main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const button = {
      concept: "start",
      requiredCapabilities: ["pointer_activatable"],
      preferredEvidence: {
        roles: ["button"],
        names: ["Start"],
        labels: [],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: ["hidden", "disabled"],
      risk: "ordinary",
      confidence: { requiredFamilies: [] },
    };
    const resultRegion = {
      concept: "result",
      requiredCapabilities: ["readable_value"],
      preferredEvidence: {
        roles: ["region"],
        names: ["Result"],
        labels: [],
        descriptions: [],
        placeholders: [],
        inputTypes: [],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: ["hidden"],
      risk: "ordinary",
      confidence: { requiredFamilies: [] },
    };
    const plan = currentPlanSchema.parse({
      name: "Independent post-action readiness",
      objective: "Prove readiness budget independence",
      allowedOrigins: [origin],
      budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open",
          action: { type: "navigate", url: origin },
          assertions: [],
          evidence: [],
          onFailure: "stop",
          captureIntent: "transient",
        },
        {
          id: "start",
          title: "Start",
          action: {
            type: "click",
            target: button,
            expectedEffect: { type: "none" },
            timeoutMs: actionTimeoutMs,
          },
          after: {
            mode: "all",
            timeoutMs: readinessTimeoutMs,
            conditions: [
              {
                type: "content",
                target: resultRegion,
                requiredText: "Ready after action deadline",
              },
            ],
          },
          assertions: [],
          evidence: [],
          onFailure: "stop",
          captureIntent: "transient",
        },
      ],
    });
    const report = await executePlan({
      plan,
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: await mkdtemp(path.join(tmpdir(), "scry-readiness-independence-")),
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      onMutationDispatch: async () => {
        dispatchCount += 1;
        dispatchAt = performance.now() - actionStartedAt;
      },
      onEvent: async (event) => {
        if (event.type === "step.started" && event.payload.stepId === "start")
          actionStartedAt = performance.now();
      },
    });
    const readiness = report.steps[1]?.readiness;
    expect(report.state).toBe("passed");
    expect(dispatchCount).toBe(1);
    expect(dispatchAt).toBeLessThan(actionTimeoutMs);
    expect(readiness).toMatchObject({ status: "passed", matchedConditions: ["content"] });
    expect(readiness!.durationMs).toBeGreaterThan(actionTimeoutMs);
    expect(readiness!.durationMs).toBeLessThan(readinessTimeoutMs);
  }, 15_000);
});
