import { describe, expect, it } from "vitest";

import {
  defineCampaign,
  defineVerification,
  runCampaign,
  type AssuranceEvidenceRef,
} from "../src/index.js";

function proof(ref: string): AssuranceEvidenceRef {
  return {
    source: "fixture",
    kind: "ground-truth",
    ref,
  };
}

describe("Assurance campaigns", () => {
  it("cannot pass with zero required cases", async () => {
    const result = await runCampaign(
      defineCampaign({
        id: "empty-proof",
        title: "Empty proof",

        cases: [
          {
            required: false,

            verification: defineVerification({
              id: "observation",
              title: "Observation",
              claim: "Something was observed",

              oracle: () => ({
                status: "pass",
                evidence: [proof("observation")],
              }),
            }),
          },
        ],
      }),
      undefined,
    );

    expect(result.status).toBe("inconclusive");
  });

  it("cannot qualify skipped required work", async () => {
    const result = await runCampaign(
      defineCampaign({
        id: "skipped",
        title: "Skipped",

        cases: [
          {
            verification: defineVerification({
              id: "required",
              title: "Required",
              claim: "Required invariant holds",
              oracle: () => ({ status: "skipped" }),
            }),
          },
        ],
      }),
      undefined,
    );

    expect(result.status).toBe("inconclusive");
  });

  it("does not silently turn an observational failure into a gate", async () => {
    const result = await runCampaign(
      defineCampaign({
        id: "observation",
        title: "Observation",

        cases: [
          {
            required: true,

            verification: defineVerification({
              id: "required",
              title: "Required",
              claim: "Required invariant holds",

              oracle: () => ({
                status: "pass",
                evidence: [proof("required")],
              }),
            }),
          },

          {
            required: false,

            verification: defineVerification({
              id: "metric",
              title: "Metric",
              claim: "An observational property is healthy",

              oracle: () => ({
                status: "fail",
                evidence: [proof("observation-failed")],
              }),
            }),
          },
        ],
      }),
      undefined,
    );

    expect(result.status).toBe("pass");
    expect(result.cases[1]!.verification.status).toBe("fail");
  });

  it("retains planned work as not_run after stop-on-failure", async () => {
    const result = await runCampaign(
      defineCampaign({
        id: "stop",
        title: "Stop",
        stopOnFailure: true,

        cases: [
          {
            verification: defineVerification({
              id: "first",
              title: "First",
              claim: "First invariant holds",

              oracle: () => ({
                status: "fail",
                evidence: [proof("first-failed")],
              }),
            }),
          },

          {
            verification: defineVerification({
              id: "second",
              title: "Second",
              claim: "Second invariant holds",

              oracle: () => ({
                status: "pass",
                evidence: [proof("second")],
              }),
            }),
          },
        ],
      }),
      undefined,
    );

    expect(result.status).toBe("fail");
    expect(result.cases[1]!.verification.status).toBe("not_run");
  });
});
