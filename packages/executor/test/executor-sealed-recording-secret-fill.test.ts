import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { expect, it } from "vitest";

import { executePlan } from "../src/executor.js";

it("continues a protected secret fill when video recording is already sealed", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html>
       <html>
         <body>
           <label for="protected-field">Protected value</label>
           <input
             id="protected-field"
             type="text"
             aria-label="Protected value"
           >
         </body>
       </html>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server unavailable");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "scry-sealed-recording-secret-fill-"),
  );

  try {
    const plan = currentPlanSchema.parse({
      name: "Sealed recording secret fill",
      objective: "Verify secret fills continue after recording degradation",
      allowedOrigins: [origin],
      budgets: {
        maxActions: 2,
        maxDurationMs: 15_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open form",
          action: {
            type: "navigate",
            url: origin,
          },
          evidence: [],
          assertions: [],
          onFailure: "stop",
          captureIntent: "final",
        },
        {
          id: "fill-secret",
          title: "Fill protected value",
          action: {
            type: "fill",
            secretRef: "00000000-0000-4000-8000-000000000001",
            target: {
              concept: "protected value",
              requiredCapabilities: ["focusable", "accepts_text", "editable"],
              preferredEvidence: {
                roles: ["textbox"],
                names: ["Protected value"],
                labels: ["Protected value"],
                descriptions: [],
                placeholders: [],
                inputTypes: ["text"],
              },
              scope: {
                kind: "page",
              },
              relations: [],
              prohibited: ["hidden", "disabled"],
              risk: "authentication",
              confidence: {
                requiredFamilies: ["native_control", "accessibility"],
                minimumFamilyCount: 2,
              },
            },
          },
          evidence: [],
          assertions: [],
          onFailure: "stop",
          captureIntent: "transient",
          transientJustification: "The entered value is sensitive.",
        },
      ],
    });

    const report = await executePlan({
      plan,
      policy: executionPolicySchema.parse({
        allowedOrigins: [origin],
        allowPrivateNetwork: true,
      }),
      outputDirectory,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      secretResolver: async () => "protected-test-value",
      recordingTestHook: async ({ recording }) => {
        await recording.seal("SYNTHETIC_SEGMENT_VALIDATION_FAILURE");
      },
    });

    expect(report.state).toBe("passed");
    expect(report.steps.find((step) => step.id === "fill-secret")).toMatchObject({
      status: "passed",
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
