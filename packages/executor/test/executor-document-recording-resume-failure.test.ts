import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { expect, it } from "vitest";

import { executePlan } from "../src/executor.js";

it("preserves observed navigation truth when recording cannot resume", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><html><body><h1>Destination observed</h1></body></html>");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable");

  const origin = `http://127.0.0.1:${address.port}`;
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "scry-document-recording-resume-failure-"),
  );

  try {
    const report = await executePlan({
      plan: currentPlanSchema.parse({
        name: "Recording resume degradation",
        objective: "Preserve observed navigation truth when only recording degrades",
        allowedOrigins: [origin],
        budgets: {
          maxActions: 1,
          maxDurationMs: 15_000,
          maxNavigations: 1,
        },
        checkpoints: [],
        steps: [
          {
            id: "open",
            title: "Open destination",
            action: { type: "navigate", url: origin },
            evidence: [],
            assertions: [],
            onFailure: "stop",
            captureIntent: "final",
          },
        ],
      }),
      policy: executionPolicySchema.parse({
        allowedOrigins: [origin],
        allowPrivateNetwork: true,
      }),
      outputDirectory,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      recordingSegmentStartTestHook: async (reason) => {
        if (reason === "document_resume") throw new Error("SYNTHETIC_SCREENCAST_START_FAILED");
      },
    });

    expect(report.state).toBe("passed");
    expect(report.steps).toMatchObject([{ id: "open", status: "passed" }]);
    expect(report.artifactTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "document_transition_gap",
          captureStatus: "intentionally_suppressed",
        }),
        expect.objectContaining({
          type: "unavailable_interval",
          failureCode: "SCREENCAST_START_FAILED",
        }),
      ]),
    );

    const events = (await readFile(path.join(outputDirectory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "recording.sealed",
          payload: expect.objectContaining({ reason: "SCREENCAST_START_FAILED" }),
        }),
      ]),
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
