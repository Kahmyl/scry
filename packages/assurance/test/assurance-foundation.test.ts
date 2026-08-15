import {
  describe,
  expect,
  it,
} from "vitest";

import {
  defineCampaign,
  defineFixture,
  defineLiveJourney,
  defineVerification,
  runCampaign,
  runLiveJourney,
  runVerification,
  runVerificationAttempts,
  withFixture,
  type AssuranceEvidenceRef,
} from "../src/index.js";

function proof(
  ref: string,
): AssuranceEvidenceRef {
  return {
    source: "fixture",
    kind: "ground-truth",
    ref,
  };
}

describe("Assurance truth model", () => {
  it("refuses to pass without evidence", async () => {
    const verification = defineVerification({
      id: "no-evidence",
      title: "No evidence",
      claim: "The operation succeeded",

      oracle: () => ({
        status: "pass",
      }),
    });

    const result = await runVerification(
      verification,
      undefined,
    );

    expect(result.status)
      .toBe("inconclusive");

    expect(result.reasonCode)
      .toBe("PASS_WITHOUT_EVIDENCE");
  });

  it("accepts a pass supported by evidence", async () => {
    const verification = defineVerification({
      id: "proved",
      title: "Proved",
      claim: "The fixture observed one dispatch",

      oracle: () => ({
        status: "pass",
        evidence: [
          proof("dispatch-count:1"),
        ],
      }),
    });

    const result = await runVerification(
      verification,
      undefined,
    );

    expect(result.status)
      .toBe("pass");
  });

  it("refuses an unsupported fail verdict", async () => {
    const verification = defineVerification({
      id: "unsupported-fail",
      title: "Unsupported fail",
      claim: "The invariant does not hold",

      oracle: () => ({
        status: "fail",
      }),
    });

    const result = await runVerification(
      verification,
      undefined,
    );

    expect(result.status)
      .toBe("inconclusive");

    expect(result.reasonCode)
      .toBe("FAIL_WITHOUT_EVIDENCE");
  });

  it("preserves mixed retry outcomes as inconclusive", async () => {
    let attempt = 0;

    const verification = defineVerification({
      id: "flaky",
      title: "Flaky",
      claim: "The capability is stable",

      oracle: () => {
        attempt += 1;

        return attempt === 1
          ? {
              status: "fail" as const,
              evidence: [
                proof("attempt-1-failed"),
              ],
            }
          : {
              status: "pass" as const,
              evidence: [
                proof("attempt-2-passed"),
              ],
            };
      },
    });

    const result =
      await runVerificationAttempts(
        verification,
        undefined,
        2,
      );

    expect(result.status)
      .toBe("inconclusive");

    expect(result.reasonCode)
      .toBe("MIXED_ATTEMPT_OUTCOMES");

    expect(result.attempts)
      .toHaveLength(2);
  });

  it("exposes independent fixture ground truth", async () => {
    const lifecycle: string[] = [];

    const fixture = defineFixture({
      id: "dispatch-fixture",
      title: "Dispatch fixture",

      setup: () => {
        lifecycle.push("setup");

        const dispatchCount = 1;

        return {
          value: {
            origin: "https://fixture.test",
          },

          readGroundTruth: () => ({
            dispatchCount,
          }),
        };
      },

      teardown: () => {
        lifecycle.push("teardown");
      },
    });

    await withFixture(
      fixture,
      undefined,
      async session => {
        lifecycle.push("use");

        expect(
          await session.readGroundTruth(),
        ).toEqual({
          dispatchCount: 1,
        });
      },
    );

    expect(lifecycle).toEqual([
      "setup",
      "use",
      "teardown",
    ]);
  });

  it("does not qualify skipped required work", async () => {
    const campaign = defineCampaign({
      id: "campaign",
      title: "Campaign",

      cases: [
        {
          verification: defineVerification({
            id: "required",
            title: "Required",
            claim: "Required capability works",

            oracle: () => ({
              status: "skipped",
            }),
          }),
        },
      ],
    });

    const result = await runCampaign(
      campaign,
      undefined,
    );

    expect(result.status)
      .toBe("inconclusive");
  });

  it("keeps observational failures visible without turning them into hidden gates", async () => {
    const campaign = defineCampaign({
      id: "campaign",
      title: "Campaign",

      cases: [
        {
          required: true,

          verification: defineVerification({
            id: "required",
            title: "Required",
            claim: "Required invariant holds",

            oracle: () => ({
              status: "pass",
              evidence: [
                proof("required-proof"),
              ],
            }),
          }),
        },

        {
          required: false,

          verification: defineVerification({
            id: "observation",
            title: "Observation",
            claim: "Optional observation is healthy",

            oracle: () => ({
              status: "fail",
              evidence: [
                proof("optional-failure"),
              ],
            }),
          }),
        },
      ],
    });

    const result = await runCampaign(
      campaign,
      undefined,
    );

    expect(result.status)
      .toBe("pass");

    expect(
      result.cases[1]!.verification.status,
    ).toBe("fail");
  });

  it("marks unexecuted campaign work not_run", async () => {
    const campaign = defineCampaign({
      id: "campaign",
      title: "Campaign",
      stopOnFailure: true,

      cases: [
        {
          verification: defineVerification({
            id: "failure",
            title: "Failure",
            claim: "First condition holds",

            oracle: () => ({
              status: "fail",
              evidence: [
                proof("failure"),
              ],
            }),
          }),
        },

        {
          verification: defineVerification({
            id: "later",
            title: "Later",
            claim: "Later condition holds",

            oracle: () => ({
              status: "pass",
              evidence: [
                proof("later"),
              ],
            }),
          }),
        },
      ],
    });

    const result = await runCampaign(
      campaign,
      undefined,
    );

    expect(result.status)
      .toBe("fail");

    expect(
      result.cases[1]!.verification.status,
    ).toBe("not_run");
  });

  it("requires explicit journey completion proof", async () => {
    const journey = defineLiveJourney({
      id: "journey",
      title: "Journey",
      surface: "https://example.test",

      steps: [
        {
          id: "step",
          title: "Step",
          intent: "Perform browser operation",

          execute: () => ({
            status: "pass",
            evidence: [
              proof("operation-completed"),
            ],
          }),
        },
      ],

      completion: defineVerification({
        id: "completion",
        title: "Completion",
        claim: "The actual task outcome exists",

        oracle: () => ({
          status: "inconclusive",
          evidence: [
            proof("outcome-not-established"),
          ],
        }),
      }),
    });

    const result = await runLiveJourney(
      journey,
      undefined,
    );

    expect(
      result.steps[0]!.verification.status,
    ).toBe("pass");

    expect(result.completion.status)
      .toBe("inconclusive");

    expect(result.status)
      .toBe("inconclusive");
  });

  it("marks remaining journey work not_run after required failure", async () => {
    const journey = defineLiveJourney({
      id: "journey",
      title: "Journey",
      surface: "https://example.test",

      steps: [
        {
          id: "first",
          title: "First",
          intent: "First required operation",

          execute: () => ({
            status: "fail",
            evidence: [
              proof("first-failed"),
            ],
          }),
        },

        {
          id: "second",
          title: "Second",
          intent: "Second required operation",

          execute: () => ({
            status: "pass",
            evidence: [
              proof("second-passed"),
            ],
          }),
        },
      ],

      completion: defineVerification({
        id: "completion",
        title: "Completion",
        claim: "Journey completed",

        oracle: () => ({
          status: "pass",
          evidence: [
            proof("completed"),
          ],
        }),
      }),
    });

    const result = await runLiveJourney(
      journey,
      undefined,
    );

    expect(
      result.steps[0]!.verification.status,
    ).toBe("fail");

    expect(
      result.steps[1]!.verification.status,
    ).toBe("not_run");

    expect(result.completion.status)
      .toBe("not_run");

    expect(result.status)
      .toBe("fail");
  });

  it("passes only when required steps and completion are proven", async () => {
    const journey = defineLiveJourney({
      id: "journey",
      title: "Journey",
      surface: "https://example.test",

      steps: [
        {
          id: "step",
          title: "Step",
          intent: "Perform required work",

          execute: () => ({
            status: "pass",
            evidence: [
              proof("step-proof"),
            ],
          }),
        },
      ],

      completion: defineVerification({
        id: "completion",
        title: "Completion",
        claim: "Task outcome is correct",

        oracle: () => ({
          status: "pass",
          evidence: [
            proof("completion-proof"),
          ],
        }),
      }),
    });

    const result = await runLiveJourney(
      journey,
      undefined,
    );

    expect(result.status)
      .toBe("pass");
  });
});
