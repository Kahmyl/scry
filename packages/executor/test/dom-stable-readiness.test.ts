import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";

import { executePlan } from "../src/executor.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("DOM-stable readiness", () => {
  it("waits outside the browser evaluation realm without injected helper references", async () => {
    const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<main>ready</main>"); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const plan = currentPlanSchema.parse({
      name: "DOM stable", objective: "Verify readiness", allowedOrigins: [origin], budgets: { maxActions: 1, maxDurationMs: 20_000, maxNavigations: 1 }, checkpoints: [],
      steps: [{ id: "open", title: "Open", action: { type: "navigate", url: origin }, after: { mode: "all", timeoutMs: 5_000, conditions: [{ type: "domStable", quietWindowMs: 200 }] }, assertions: [{ type: "url", expected: "/", match: "path" }], evidence: [], onFailure: "stop", captureIntent: "final" }],
    });
    const report = await executePlan({ plan, policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }), outputDirectory: await mkdtemp(path.join(tmpdir(), "scry-dom-stable-")), browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    expect(report.state).toBe("passed");
    expect(report.steps[0]?.readiness).toMatchObject({ status: "passed" });
  }, 15_000);
});
