import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { publicCausalProjection } from "../src/architecture/q2/causal-envelope.js";
import { FailpointController } from "../src/architecture/q2/failpoints.js";
import { startDispatchOracle, type DispatchOracle } from "../src/architecture/q2/oracle.js";
import { createQ2Report } from "../src/architecture/q2/report.js";
import { runQ2Scenario, q2SafeScope } from "../src/architecture/q2/runner.js";
import { q2PairedScenarios, q2Scenarios } from "../src/architecture/q2/scenarios.js";
import { evaluateInvariants } from "../src/architecture/q1/invariants.js";
import { applyReferenceAction, createReferenceState } from "../src/architecture/q1/state.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let oracle: DispatchOracle | undefined;
afterEach(async () => {
  await oracle?.close();
  oracle = undefined;
});

describe("Q2 deterministic B1-B20 fault matrix", () => {
  it("maps exactly one stable failpoint to every canonical boundary and fires deterministically", () => {
    expect(q2Scenarios).toHaveLength(20);
    expect(new Set(q2Scenarios.map(({ boundary }) => boundary)).size).toBe(20);
    expect(new Set(q2Scenarios.map(({ failpoint }) => failpoint.name)).size).toBe(20);
    for (const scenario of q2Scenarios) {
      const result = runQ2Scenario(scenario);
      expect(result.ledger).toEqual([
        expect.objectContaining({
          name: scenario.failpoint.name,
          boundary: scenario.boundary,
          invocation: 1,
          firedAtOrdinal: 1,
          scope: q2SafeScope,
        }),
      ]);
      expect(result.snapshot.operation).toMatchObject({
        mutationTruth: scenario.expected.mutation,
        functionalTruth: scenario.expected.functional,
        dispatchCount: scenario.expected.dispatchCount,
      });
      expect(result.snapshot.truth).toMatchObject({
        privacy: scenario.expected.privacy,
        evidence: scenario.expected.evidence,
        runtime: scenario.expected.runtime,
      });
      expect(result.envelope).toMatchObject({
        phase: scenario.phase,
        component: scenario.component,
        dispatchBoundary: scenario.dispatchCategory,
        retryClass: scenario.retryClass,
        truth: {
          mutation: scenario.expected.mutation,
          functional: scenario.expected.functional,
        },
      });
    }
  });

  it("keeps persistence, runtime, evidence, and product truth independent", () => {
    for (const boundary of ["B9", "B10", "B11", "B12", "B13", "B14", "B15", "B16", "B20"]) {
      const result = runQ2Scenario(q2Scenarios.find((scenario) => scenario.boundary === boundary)!);
      expect(result.snapshot.operation.mutationTruth).toBe("applied");
      expect(result.snapshot.truth.runtime).toBe("healthy");
      if (boundary === "B20") {
        expect(result.snapshot.truth.telemetry).toBe("failed");
        expect(result.snapshot.truth.evidence).toBe("available");
      }
    }
  });

  it("evaluates Q1 after every fault after the B19 lifecycle correction", () => {
    for (const scenario of q2Scenarios) {
      const violations = runQ2Scenario(scenario).violations.map(({ invariantId }) => invariantId);
      expect(violations, scenario.id).toEqual([]);
    }
  });

  it("retains the committed required and optional evidence policy matrix", () => {
    for (const state of ["available", "pending", "failed", "quarantined"] as const) {
      let snapshot = applyReferenceAction(createReferenceState(), {
        type: "settleEvidence",
        state,
        required: true,
      });
      snapshot = applyReferenceAction(snapshot, { type: "finalizeRun", state: "passed" });
      const p04 = evaluateInvariants(snapshot).find(({ invariantId }) => invariantId === "P04");
      expect(p04?.status, `required:${state}`).toBe(state === "available" ? "pass" : "fail");
    }
    for (const state of ["available", "suppressed", "failed", "quarantined"] as const) {
      const snapshot = applyReferenceAction(createReferenceState(), {
        type: "settleEvidence",
        state,
        required: false,
      });
      expect(snapshot.truth.evidence).toBe(state);
      expect(
        evaluateInvariants(snapshot).find(({ invariantId }) => invariantId === "P04")?.status,
      ).toBe("pass");
    }
  });

  it("detects broken causal, redispatch, and malformed-history controls", () => {
    const broken = [
      {
        action: {
          type: "testOnlyCorrupt",
          path: "truth.causalEnvelopeRetained",
          value: false,
        } as const,
        invariant: "T08",
      },
      {
        actions: [{ type: "crossDispatch" }, { type: "crossDispatch" }] as const,
        invariant: "M05",
      },
      {
        action: {
          type: "testOnlyCorrupt",
          path: "recovery.malformedAuthorityAccepted",
          value: true,
        } as const,
        invariant: "R02",
      },
    ];
    for (const control of broken) {
      let snapshot = createReferenceState();
      for (const action of "actions" in control ? control.actions : [control.action])
        snapshot = applyReferenceAction(snapshot, action);
      expect(
        evaluateInvariants(snapshot).find(({ invariantId }) => invariantId === control.invariant)
          ?.status,
      ).toBe("fail");
    }
  });

  it("proves exception type cannot choose mutation truth across paired dispatch boundaries", () => {
    const before = q2PairedScenarios.find(({ id }) => id === "pair-b3-before")!;
    const after = q2PairedScenarios.find(({ id }) => id === "pair-b4-after-fence")!;
    expect(before.mutation).toBe("not_applied");
    expect(after.mutation).toBe("unknown");
    expect(before.dispatch).not.toBe(after.dispatch);
    expect(q2PairedScenarios.map(({ boundary }) => boundary)).toEqual(
      expect.arrayContaining(["B3", "B4", "B5", "B6", "B7", "B17", "B18"]),
    );
  });

  it("uses an independent local HTTP oracle to distinguish no dispatch from exactly one dispatch", async () => {
    oracle = await startDispatchOracle();
    const operationId = "operation-oracle-q2";
    const readTruth = async () =>
      fetch(`${oracle!.truthUrl}/${operationId}`).then((response) => response.json()) as Promise<{
        mutationRequestCount: number;
      }>;
    expect((await readTruth()).mutationRequestCount).toBe(0);
    await fetch(oracle.mutationUrl, {
      method: "POST",
      headers: { "idempotency-key": operationId },
    });
    expect((await readTruth()).mutationRequestCount).toBe(1);
  });

  it("keeps the private causal chain and exposes only a bounded public projection", () => {
    const result = runQ2Scenario(q2Scenarios.find(({ boundary }) => boundary === "B9")!);
    const projection = publicCausalProjection(result.envelope);
    expect(projection.phase).toBe("verified_observation_persistence");
    expect(projection.causeCategory).toBe("persistence");
    expect(projection).not.toHaveProperty("causality.projectId");
    expect(JSON.stringify(projection)).not.toMatch(
      /stack|requestBody|responseBody|selector|cookie|sql/i,
    );
  });

  it("makes activation unavailable to runtime packages and rejects non-test construction", async () => {
    for (const directory of ["apps/api/src", "apps/mcp/src", "packages/praxis/src"]) {
      for (const file of await collectTypeScript(path.join(root, directory))) {
        expect(await readFile(file, "utf8"), file).not.toMatch(
          /architecture\/q2|FailpointController/,
        );
      }
    }
    const child = spawnSync(
      path.join(root, "packages/assurance/node_modules/.bin/tsx"),
      [
        "--eval",
        `import('./packages/assurance/src/architecture/q2/failpoints.ts').then(({FailpointController})=>FailpointController.approvedTestComposition([]))`,
      ],
      { cwd: root, env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8" },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(
      "Q2_FAILPOINT_CONTROLLER_REJECTED_OUTSIDE_APPROVED_TEST_PROCESS",
    );
  });

  it("keeps disabled hooks no-op and environment variables alone inert", () => {
    const disabled = FailpointController.disabled();
    for (const scenario of q2Scenarios)
      expect(() => disabled.atBoundary(scenario.failpoint.name, q2SafeScope)).not.toThrow();
    expect(
      evaluateInvariants(createReferenceState()).every(({ status }) => status === "pass"),
    ).toBe(true);
    expect(process.env.SCRY_Q2_FAILPOINT).toBeUndefined();
  });

  it("honors fireOnNth and maxFires without state bleed", () => {
    const definition = {
      ...q2Scenarios[0]!.failpoint,
      fireOnNth: 2,
      maxFires: 1,
    };
    const controller = FailpointController.approvedTestComposition([definition]);
    expect(() => controller.atBoundary(definition.name, q2SafeScope)).not.toThrow();
    expect(() => controller.atBoundary(definition.name, q2SafeScope)).toThrow("Q2_INJECTED_FAULT");
    expect(() => controller.atBoundary(definition.name, q2SafeScope)).not.toThrow();
    expect(controller.ledger()).toHaveLength(1);
  });

  it("rejects unsafe scope fields before recording a fault", () => {
    const scenario = q2Scenarios[0]!;
    const controller = FailpointController.approvedTestComposition([scenario.failpoint]);
    expect(() =>
      controller.atBoundary(scenario.failpoint.name, {
        ...q2SafeScope,
        correlationId: "secret value\nraw",
      }),
    ).toThrow("Q2_UNSAFE_FAILPOINT_SCOPE");
    expect(controller.ledger()).toEqual([]);
  });

  it("emits a deterministic report with canonical Q0/Q1 provenance and separated verdicts", async () => {
    const first = await createQ2Report(root);
    const second = await createQ2Report(root);
    expect(second).toEqual(first);
    const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    expect(first.report.source).toMatchObject({
      head: currentHead,
      schemaFingerprint: "28d920677117215af115bd2ca8728f7eb6b4094b9a675d8f3b5a5593966dc5e1",
      q0Digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      q1Digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.report.verdicts).toEqual({
      milestone3Implementation: "PASS",
      q2FaultInfrastructure: "PASS",
      q2ProductGate: "PASS",
      progression: "ELIGIBLE_FOR_MILESTONE_5",
    });
    expect(first.report.faultMatrix).toHaveLength(20);
    expect(
      first.report.faultMatrix.every(
        (scenario) =>
          scenario.proofProvenance.length > 0 &&
          scenario.resultingStateEvaluatedByQ1 &&
          scenario.productionComponentsActuallyExecuted.length > 0 &&
          scenario.mockedWrappedOrTestOnlyComponents.length > 0,
      ),
    ).toBe(true);
    expect(
      first.report.faultMatrix
        .filter(({ productionProofStatus }) => productionProofStatus === "production_proven_q2")
        .map(({ boundary }) => boundary),
    ).toEqual(["B19"]);
    expect(
      first.report.faultMatrix
        .filter(({ productionProofStatus }) => productionProofStatus === "future_proof_required")
        .map(({ boundary }) => boundary),
    ).toEqual(["B16"]);
    expect(first.report.proofProvenanceSummary).toMatchObject({
      countsByProvenance: {
        assurance_reference: 20,
        existing_regression_evidence: 20,
        repository_integration: 7,
        production_characterization: 13,
        real_browser_local: 5,
        independent_http_oracle: 5,
      },
      countsByProductionProofStatus: {
        characterized: 2,
        partially_proven: 16,
        production_proven_q2: 1,
        future_proof_required: 1,
      },
      highRiskProductionExercisedCount: 13,
      highRiskFutureProofRequiredCount: 1,
    });
    expect(first.report.productFindings).toEqual([]);
  });
});

async function collectTypeScript(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScript(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
