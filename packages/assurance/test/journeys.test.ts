import { describe, expect, it } from "vitest";

import {
  defineLiveJourney,
  defineVerification,
  runLiveJourney,
  type AssuranceEvidenceRef,
} from "../src/index.js";

function proof(ref: string): AssuranceEvidenceRef {
  return {
    source: "fixture",
    kind: "ground-truth",
    ref,
  };
}

describe("Assurance journeys", () => {
  it("cannot pass only because its operations succeeded", async () => {
    const result = await runLiveJourney(
      defineLiveJourney({
        id: "journey",
        title: "Journey",
        surface: "https://example.test",

        steps: [
          {
            id: "action",
            title: "Action",
            intent: "Perform action",

            execute: () => ({
              status: "pass",
              evidence: [proof("action")],
            }),
          },
        ],

        completion: defineVerification({
          id: "completion",
          title: "Completion",
          claim: "Task outcome actually exists",

          oracle: () => ({
            status: "inconclusive",
            evidence: [proof("outcome-unproven")],
          }),
        }),
      }),
      undefined,
    );

    expect(result.steps[0]!.verification.status).toBe("pass");
    expect(result.completion.status).toBe("inconclusive");
    expect(result.status).toBe("inconclusive");
  });

  it("does not execute later required work after required failure by default", async () => {
    let secondExecuted = false;

    const result = await runLiveJourney(
      defineLiveJourney({
        id: "journey-stop",
        title: "Journey stop",
        surface: "https://example.test",

        steps: [
          {
            id: "first",
            title: "First",
            intent: "First operation",

            execute: () => ({
              status: "fail",
              evidence: [proof("first-failed")],
            }),
          },

          {
            id: "second",
            title: "Second",
            intent: "Second operation",

            execute: () => {
              secondExecuted = true;

              return {
                status: "pass",
                evidence: [proof("second")],
              };
            },
          },
        ],

        completion: defineVerification({
          id: "completion",
          title: "Completion",
          claim: "Task completed",

          oracle: () => ({
            status: "pass",
            evidence: [proof("completion")],
          }),
        }),
      }),
      undefined,
    );

    expect(secondExecuted).toBe(false);
    expect(result.steps[1]!.verification.status).toBe("not_run");
    expect(result.completion.status).toBe("not_run");
    expect(result.status).toBe("fail");
  });

  it("passes only when required work and final outcome are positively proven", async () => {
    const result = await runLiveJourney(
      defineLiveJourney({
        id: "proved",
        title: "Proved journey",
        surface: "https://example.test",

        steps: [
          {
            id: "step",
            title: "Step",
            intent: "Perform required operation",

            execute: () => ({
              status: "pass",
              evidence: [proof("step")],
            }),
          },
        ],

        completion: defineVerification({
          id: "completion",
          title: "Completion",
          claim: "Final outcome exists",

          oracle: () => ({
            status: "pass",
            evidence: [proof("final-outcome")],
          }),
        }),
      }),
      undefined,
    );

    expect(result.status).toBe("pass");
  });
});
