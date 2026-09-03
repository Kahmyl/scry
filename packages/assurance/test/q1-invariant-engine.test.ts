import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { correctnessManifest } from "../src/architecture/q0/manifest.js";
import {
  ContractHelperAdapter,
  PostgresQ1Adapter,
  PureReferenceAdapter,
} from "../src/architecture/q1/adapters.js";
import {
  negativeEvaluationCase,
  q1MandatoryNegativeControls,
  q1SeedCorpus,
} from "../src/architecture/q1/corpus.js";
import { assertCompleteRegistry, evaluateInvariants } from "../src/architecture/q1/invariants.js";
import { createQ1Report } from "../src/architecture/q1/report.js";
import { reproductionFor, runSequence } from "../src/architecture/q1/runner.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Q1 executable truth engine", () => {
  it("executes every committed Q0 invariant with one positive and one negative proof", () => {
    assertCompleteRegistry();
    const positive = evaluateInvariants(new PureReferenceAdapter().acquire());
    expect(positive).toHaveLength(52);
    expect(positive.every(({ status }) => status === "pass")).toBe(true);

    for (const invariant of correctnessManifest.invariants) {
      const fixture = negativeEvaluationCase(invariant.id);
      const result = evaluateInvariants(fixture.after, fixture.before, fixture.action).find(
        ({ invariantId }) => invariantId === invariant.id,
      );
      expect(result, invariant.id).toMatchObject({ invariantId: invariant.id, status: "fail" });
    }
  });

  it("runs the deterministic scenario corpus without unexpected violations", () => {
    for (const entry of q1SeedCorpus) {
      const observed = [
        ...new Set(runSequence(entry).violations.map(({ invariantId }) => invariantId)),
      ];
      expect(observed.sort(), entry.id).toEqual([...entry.expectedViolationIds].sort());
    }
  });

  it("catches all ten mandatory broken sequences and emits reducible reproductions", async () => {
    const { digest } = await import("../src/architecture/q0/report.js").then(({ createQ0Report }) =>
      createQ0Report(root),
    );
    for (const entry of q1MandatoryNegativeControls) {
      const run = runSequence(entry);
      for (const invariantId of entry.expectedViolationIds) {
        expect(
          run.violations.some((violation) => violation.invariantId === invariantId),
          entry.id,
        ).toBe(true);
        const reproduction = reproductionFor({
          sequence: entry,
          invariantId,
          release: "test-release",
          schemaFingerprint: "a".repeat(64),
          q0ManifestDigest: digest,
        });
        expect(reproduction.actions.length).toBeLessThanOrEqual(entry.actions.length);
        expect(runSequence({ ...entry, actions: reproduction.actions }).violations).toEqual(
          expect.arrayContaining([expect.objectContaining({ invariantId })]),
        );
      }
    }
  });

  it("delegates production enum and protected transition graph checks to current contracts", () => {
    const result = new ContractHelperAdapter().exercise();
    expect(result.checks).toBeGreaterThan(100);
    expect(result.protectedStates).toBeGreaterThan(10);
  });

  it("translates durable repository rows and keeps protected mutation truth canonical", async () => {
    const database = {
      async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        if (sql.includes("FROM mission_objectives"))
          return {
            rows: [
              {
                missionId: "mission-1",
                projectId: "project-1",
                objectiveId: "objective-1",
                objectiveState: "running",
                conclusion: null,
                acceptedEvidence: false,
                missionState: "active",
              } as unknown as T,
            ],
          };
        if (sql.includes("FROM runs run"))
          return {
            rows: [
              {
                runId: "run-1",
                projectId: "project-1",
                environmentId: "environment-1",
                agentSessionId: "agent-1",
                runState: "running",
                resultClassification: null,
                attemptStates: ["running"],
                attemptHistory: [
                  {
                    attemptId: "attempt-1",
                    attemptNumber: 1,
                    state: "running",
                    claimToken: "claim-1",
                  },
                ],
              } as unknown as T,
            ],
          };
        return {
          rows: [
            {
              praxisSessionId: "praxis-1",
              projectId: "project-1",
              environmentId: "environment-1",
              agentSessionId: "agent-1",
              praxisState: "active",
              operationId: "operation-1",
              mutationIdentity: "mutation-1",
              providerIdempotencyIdentity: "provider-1",
              adaptiveState: "failed",
              protectedState: "completed",
              adaptiveTruth: "unknown",
              protectedTruth: "applied",
              functionalTruth: "inconclusive",
              operationKind: "protected_mutation",
              dispatchCount: 1,
            } as unknown as T,
          ],
        };
      },
    };
    const snapshot = await new PostgresQ1Adapter(database).acquire({
      missionId: "mission-1",
      objectiveId: "objective-1",
      runId: "run-1",
      praxisSessionId: "praxis-1",
      operationId: "operation-1",
    });
    expect(snapshot.operation).toMatchObject({
      protectedTruth: "applied",
      adaptiveProjectionTruth: "unknown",
      mutationTruth: "applied",
    });
    expect(
      evaluateInvariants(snapshot).find(({ invariantId }) => invariantId === "T01")?.status,
    ).toBe("fail");
  });

  it("reports Q1 PASS and Q2 eligibility separately from full-system readiness", async () => {
    const first = await createQ1Report(root);
    const second = await createQ1Report(root);
    expect(second).toEqual(first);
    expect(first.report).toMatchObject({
      milestone2Implementation: "PASS",
      q1Engine: "PASS",
      stabilizationProgression: "ELIGIBLE_FOR_Q2",
      fullSystemReadiness: "BLOCKED",
      counts: {
        invariants: 52,
        assertionExecutable: 52,
        currentProductionProven: 1,
        positiveControls: 52,
        invariantNegativeControls: 52,
        mandatoryNegativeControls: 10,
        knownProductGaps: 0,
      },
    });
    expect(first.report.stabilizationProgram).toHaveLength(7);
    expect(first.report.proofLedger.find(({ invariantId }) => invariantId === "Q01")).toMatchObject(
      {
        proofRequirements: [{ proofGate: "dashboard_projection", ownerMilestone: 7 }],
      },
    );
    expect(first.report.proofLedger.find(({ invariantId }) => invariantId === "Q04")).toMatchObject(
      {
        proofStatus: "production_proven_q5",
        proofRequirements: [],
      },
    );
    expect(JSON.stringify(first.report)).not.toContain(["Milestone", "8"].join(" "));
    expect(first.report.q7.meaning).toBe("REAL Stage 6 Test Mode qualification");
  });

  it("is absent from production runtime imports and uses no protected plaintext fixtures", async () => {
    const productionRoots = [
      path.join(root, "apps/api/src"),
      path.join(root, "packages/praxis/src"),
      path.join(root, "packages/veil/src"),
    ];
    for (const productionRoot of productionRoots) {
      for (const file of await collectTypeScript(productionRoot)) {
        expect(await readFile(file, "utf8"), file).not.toMatch(/architecture\/q1/);
      }
    }
    const source = await readFile(
      path.join(root, "packages/assurance/src/architecture/q1/state.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/password|secretValue|plaintextValue/i);
  });
});

async function collectTypeScript(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScript(target)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
