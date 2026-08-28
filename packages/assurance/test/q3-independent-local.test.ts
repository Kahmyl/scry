import { describe, expect, it } from "vitest";

import { compareIndependentTruth } from "../src/architecture/q3/comparator.js";
import { runQ3Campaign } from "../src/architecture/q3/runner.js";
import { q3Scenarios } from "../src/architecture/q3/scenarios.js";
import type { Q3OracleTruth, Q3ScryView } from "../src/architecture/q3/types.js";

describe.sequential("Q3 independent local system qualification", () => {
  it(
    "executes Q3-01 through Q3-14 against real browser and independent fixture truth",
    { timeout: 180_000 },
    async () => {
      const campaign = await runQ3Campaign({ seedBase: 5300 });
      expect(campaign.order).toEqual(q3Scenarios.map(({ id }) => id));
      expect(campaign.oracleControl).toEqual({
        ordinaryStatus: 404,
        unauthenticatedControlStatus: 403,
      });
      expect(campaign.scenarios).toHaveLength(14);
      for (const scenario of campaign.scenarios) {
        expect(scenario.verdict, `${scenario.id}: ${scenario.comparisonReasons.join(",")}`).toBe(
          "PASS",
        );
        expect(scenario.q1.result).toBe("PASS");
        expect(scenario.comparison).toBe("PASS");
        expect(scenario.lifecycleResidue).toEqual([]);
        expect(scenario.proofProvenance).toContain("independent_fixture_oracle");
        expect(scenario.proofProvenance).toContain("real_browser_local");
      }
      expect(
        campaign.scenarios.find(({ id }) => id === "Q3-02")?.oracle.mutationRequests,
      ).toHaveLength(0);
      expect(campaign.scenarios.find(({ id }) => id === "Q3-06")?.oracle).toMatchObject({
        mutationRequests: [{ idempotencyKey: "q3-key-5305" }, { idempotencyKey: "q3-key-5305" }],
        resources: [{ id: "resource-5305-1" }],
      });
      expect(campaign.scenarios.find(({ id }) => id === "Q3-07")?.scry.reconciliationResult).toBe(
        "proven_applied",
      );
      expect(campaign.scenarios.find(({ id }) => id === "Q3-08")?.scry.reconciliationResult).toBe(
        "proven_not_applied",
      );
      expect(campaign.scenarios.find(({ id }) => id === "Q3-09")?.scry.reconciliationResult).toBe(
        "still_unknown",
      );
      expect(campaign.scenarios.find(({ id }) => id === "Q3-14")?.oracle).toMatchObject({
        cleanupRequests: 1,
        cleanupEffects: 1,
      });
    },
  );

  it("rejects every adversarial oracle disagreement", () => {
    const oracle = referenceOracle();
    const scry = referenceScry();
    const compare = (
      candidate: Parameters<typeof compareIndependentTruth>[0]["oracle"],
      update = {},
    ) =>
      compareIndependentTruth({
        oracle: candidate,
        scry,
        expectedGeneration: 1,
        expectedMutationRequests: 1,
        expectedCreatedResources: 1,
        ...update,
      }).verdict;
    expect(compare({ ...oracle, resources: [{ ...oracle.resources[0]!, id: "wrong-id" }] })).toBe(
      "FAIL",
    );
    expect(compare({ ...oracle, mutationRequests: [] })).toBe("FAIL");
    expect(
      compare({
        ...oracle,
        resources: [...oracle.resources, { ...oracle.resources[0]!, id: "hidden-duplicate" }],
      }),
    ).toBe("FAIL");
    expect(compare({ ...oracle, generation: 0 })).toBe("FAIL");
    expect(compare({ ...oracle, source: "scry" })).toBe("FAIL");
  });
});

function referenceOracle(): Q3OracleTruth {
  return {
    source: "independent_fixture_oracle",
    generation: 1,
    mutationRequests: [
      {
        idempotencyKey: "key-1",
        operationCorrelation: "operation-1",
        mode: "NORMAL",
        committed: true,
        response: "normal",
        receivedSequence: 1,
        acknowledgedSequence: 2,
      },
    ],
    resources: [
      { id: "resource-1", label: "fixture", quantity: 1, state: "active", idempotencyKey: "key-1" },
    ],
    retrievalCount: 1,
    authenticationSuccessCount: 1,
    documentGeneration: 1,
    targetReplacementCount: 0,
    workerRequestCount: 1,
    evidenceMode: "REQUIRED_AVAILABLE",
    cleanupRequests: 0,
    cleanupEffects: 0,
  };
}

function referenceScry(): Q3ScryView {
  return {
    dispatchBoundary: "acknowledged",
    functionalTruth: "succeeded",
    mutationTruth: "applied",
    runtimeTruth: "healthy",
    evidenceTruth: "available",
    lifecycle: "passed/active",
    resourceIdentity: "resource-1",
    reconciliationResult: "none",
    redispatchCount: 0,
  };
}
