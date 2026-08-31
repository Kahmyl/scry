import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executionPolicySchema } from "@scry/contracts";
import { BrowserSessionProvenance, openPraxisBrowserSession } from "@scry/praxis";
import { expect, it } from "vitest";
import { createExecutionCapabilityManifest, ExecutionKernel } from "../src/execution-kernel.js";

it.each([true, false])(
  "settles delayed login navigation before capture and preserves expected-effect truth (matches=%s)",
  async (matches) => {
    let loginRequests = 0;
    let destinationServed = false;
    const server = createServer((request, response) => {
      if (request.url === "/login") {
        loginRequests++;
        setTimeout(() => response.end("ok"), 700);
        return;
      }
      response.setHeader("content-type", "text/html");
      if (request.url === "/destination") {
        destinationServed = true;
        response.end("<h1>Signed in</h1>");
      } else
        response.end(
          `<button onclick="fetch('/login',{method:'POST'}).then(()=>location.href='/destination')">Login</button>`,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
    const origin = `http://127.0.0.1:${address.port}`;
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "scry-navigation-settlement-"));
    const session = await openPraxisBrowserSession({
      headless: true,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      context: { serviceWorkers: "block", acceptDownloads: false },
    });
    try {
      await session.page.goto(origin);
      await session.page.waitForLoadState("networkidle");
      const expectedUrl = origin + (matches ? "/destination" : "/wrong-expectation");
      const correlationId = randomUUID();
      const policy = executionPolicySchema.parse({
        allowedOrigins: [origin],
        allowPrivateNetwork: true,
      });
      const captureStates: boolean[] = [];
      let mutationState = "planned";
      const result = await new ExecutionKernel().interactWithReport({
        request: {
          sessionId: randomUUID(),
          operationId: randomUUID(),
          correlationId,
          mode: "run",
          policy,
          mutationIdentity: randomUUID(),
        },
        capabilities: {
          manifest: createExecutionCapabilityManifest({ mode: "run", correlationId }),
          journal: {
            begin: async () => {},
            complete: async () => {},
            fail: async () => {},
            settle: async () => {},
          },
          mutationFence: {
            claim: async () => ({ state: mutationState, fencingToken: 1 }),
            transition: async ({ expected, next }) => {
              if (mutationState !== expected) return false;
              mutationState = next;
              return true;
            },
          },
          options: {
            outputDirectory,
            recordingTestHook: async () => {
              await session.page.evaluate(() => (document.body.style.background = "lightblue"));
              await new Promise((resolve) => setTimeout(resolve, 250));
            },
            veilAdmissionKey: "test-navigation-settlement-admission-key-32-bytes",
            recordingSegmentStartTestHook: async (reason) => {
              if (reason !== "document_resume") return;
              const settled = destinationServed && session.page.url() === origin + "/destination";
              captureStates.push(settled);
              if (!settled) throw new Error("CAPTURE_BEFORE_LOGIN_NAVIGATION_SETTLED");
            },
          },
        },
        page: session.page,
        safeSession: { ...session, provenance: new BrowserSessionProvenance(randomUUID(), "safe") },
        action: {
          type: "click",
          dispatchSemantics: "mutation",
          timeoutMs: 1500,
          expectedEffect: { type: "navigation", url: expectedUrl, match: "exact" },
          target: {
            concept: "Login",
            requiredCapabilities: ["pointer_activatable"],
            preferredEvidence: {
              roles: ["button"],
              names: ["Login"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "page" },
            relations: [],
            prohibited: ["hidden", "disabled"],
            risk: "authentication",
            confidence: {
              requiredFamilies: [],
              minimum: 0.35,
              minimumMargin: 0,
              minimumFamilyCount: 1,
            },
          },
        },
        expectedEffect: { type: "navigation", url: expectedUrl, match: "exact" },
        ordinal: 1,
      });
      expect(loginRequests).toBe(1);
      expect(captureStates).toEqual([true]);
      expect(result.outcome.functionalResult).toBe(matches ? "succeeded" : "failed");
      expect(result.outcome.mutationOutcome).toBe("applied");
      if (!matches) expect(result.report.outcomeClassification).toBe("readiness_timeout");
      expect(result.outcome.privacyResult).toBe("verified");
      expect(
        result.report.artifactTimeline.some((entry) => entry.type === "unavailable_interval"),
      ).toBe(false);
    } finally {
      await session.browser.close();
      await rm(outputDirectory, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
