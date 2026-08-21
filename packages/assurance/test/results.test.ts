import { describe, expect, it } from "vitest";

import {
  defineVerification,
  runVerification,
  runVerificationAttempts,
  type AssuranceEvidenceRef,
} from "../src/index.js";

function proof(ref: string): AssuranceEvidenceRef {
  return {
    source: "fixture",
    kind: "ground-truth",
    ref,
  };
}

describe("Assurance result truth", () => {
  it("refuses to pass without evidence", async () => {
    const result = await runVerification(
      defineVerification({
        id: "unsupported-pass",
        title: "Unsupported pass",
        claim: "The operation succeeded",
        oracle: () => ({ status: "pass" }),
      }),
      undefined,
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reasonCode).toBe("PASS_WITHOUT_EVIDENCE");
  });

  it("accepts a pass supported by evidence", async () => {
    const result = await runVerification(
      defineVerification({
        id: "supported-pass",
        title: "Supported pass",
        claim: "Dispatch occurred",
        oracle: () => ({
          status: "pass",
          evidence: [proof("dispatch:1")],
        }),
      }),
      undefined,
    );

    expect(result.status).toBe("pass");
  });

  it("refuses an unsupported failure", async () => {
    const result = await runVerification(
      defineVerification({
        id: "unsupported-fail",
        title: "Unsupported fail",
        claim: "The invariant failed",
        oracle: () => ({ status: "fail" }),
      }),
      undefined,
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reasonCode).toBe("FAIL_WITHOUT_EVIDENCE");
  });

  it("preserves mixed attempts instead of allowing a final retry to hide instability", async () => {
    let attempt = 0;

    const result = await runVerificationAttempts(
      defineVerification({
        id: "unstable",
        title: "Unstable capability",
        claim: "The capability behaves consistently",
        oracle: () => {
          attempt += 1;

          return attempt === 1
            ? {
                status: "fail" as const,
                evidence: [proof("attempt-1:failed")],
              }
            : {
                status: "pass" as const,
                evidence: [proof("attempt-2:passed")],
              };
        },
      }),
      undefined,
      2,
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reasonCode).toBe("MIXED_ATTEMPT_OUTCOMES");
    expect(result.attempts).toHaveLength(2);
  });

  it("converts oracle failure to inconclusive rather than success or unsupported failure", async () => {
    const result = await runVerification(
      defineVerification({
        id: "broken-oracle",
        title: "Broken oracle",
        claim: "The capability holds",
        oracle: () => {
          throw new Error("oracle unavailable");
        },
      }),
      undefined,
    );

    expect(result.status).toBe("inconclusive");
    expect(result.reasonCode).toBe("ORACLE_ERROR");
  });
});
