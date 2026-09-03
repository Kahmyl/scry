import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildOperationalEvent,
  parseOperationalEvent,
  type OperationalEvent,
} from "@scry/observability";
import { describe, expect, it } from "vitest";

import {
  observabilityFaultMatrix,
  qualifyObservabilityFault,
  type AssuranceEvidenceRef,
} from "../src/index.js";

describe("production-shaped cross-process observability cohort", () => {
  it("retains an exact sanitized causal event across a serialized process boundary", async () => {
    const injectedAt = "2026-08-23T12:00:00.000Z";
    const event = buildOperationalEvent({
      component: "api",
      releaseId: "qualification-release",
      schemaFingerprint: "qualification-schema",
      now: () => new Date(injectedAt),
      input: {
        name: "api.request_rejected",
        classification: "validation",
        reasonCode: "API_INPUT_VALIDATION_FAILED",
        outcome: "refused",
        causality: { correlationId: "cross-process-correlation" },
        details: { status: 400, diagnostic: "Bearer must-be-redacted" },
      },
    });
    const producer = fileURLToPath(
      new URL("./fixtures/operational-event-producer.mjs", import.meta.url),
    );
    const received = [
      parseOperationalEvent(
        await runChild(producer, [
          Buffer.from(JSON.stringify(event), "utf8").toString("base64url"),
        ]),
      ),
    ];

    expect(received).toHaveLength(1);
    expect(received[0]?.details).toMatchObject({ diagnostic: "[REDACTED]" });
    expect(JSON.stringify(received)).not.toContain("must-be-redacted");

    const scenario = observabilityFaultMatrix.find(({ id }) => id === "invalid_api_input")!;
    const proof = (kind: string): AssuranceEvidenceRef => ({
      source: "fixture",
      kind,
      ref: `cross-process:${kind}`,
    });
    const result = qualifyObservabilityFault(scenario, {
      caseId: scenario.id,
      injectedAt,
      causalContext: { correlationId: "cross-process-correlation" },
      productTruth: { value: scenario.expectedTruth, evidence: [proof("product-truth")] },
      operationalEvents: [
        {
          event: received[0]!,
          availableAt: "2026-08-23T12:00:00.100Z",
          channel: "cross_process_capture",
          evidence: [proof("operational-event")],
        },
      ],
      safeAction: { value: scenario.safeAction, evidence: [proof("safe-action")] },
      telemetryFailure: {
        injected: true,
        changedProductTruth: false,
        evidence: [proof("sink-failure")],
      },
    });

    expect(result).toMatchObject({ status: "pass", points: 8, evidenceAvailability: "available" });
  });
});

function runChild(script: string, args: readonly string[]) {
  return new Promise<unknown>((resolve, reject) => {
    const child = fork(script, [...args], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const stderr: Buffer[] = [];
    let message: unknown;
    child.on("message", (value) => {
      message = value;
    });
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && message !== undefined) resolve(message);
      else
        reject(
          new Error(
            `CROSS_PROCESS_PRODUCER_FAILED_${code}:${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
    });
  });
}
