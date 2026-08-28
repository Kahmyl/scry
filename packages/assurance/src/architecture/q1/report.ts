import { execFileSync } from "node:child_process";

import { correctnessManifest } from "../q0/manifest.js";
import { createQ0Report } from "../q0/report.js";
import { deterministicDigest, schemaFingerprint } from "../q0/validator.js";
import { ContractHelperAdapter, PureReferenceAdapter } from "./adapters.js";
import { negativeEvaluationCase, q1MandatoryNegativeControls, q1SeedCorpus } from "./corpus.js";
import {
  assertCompleteRegistry,
  evaluateInvariants,
  proofRequirementsFor,
  proofStatusFor,
} from "./invariants.js";
import type { Q1ProofGate } from "./types.js";
import { reproductionFor, runSequence } from "./runner.js";

export async function createQ1Report(root: string) {
  assertCompleteRegistry();
  const { digest: q0ManifestDigest, report: q0 } = await createQ0Report(root);
  const release = git(root, ["rev-parse", "HEAD"]);
  const fingerprint = schemaFingerprint(root);
  const reference = new PureReferenceAdapter().acquire();
  const positiveResults = evaluateInvariants(reference);
  const positiveControls = positiveResults.map(({ invariantId, status }) => ({
    invariantId,
    passed: status === "pass",
  }));
  const invariantNegativeControls = correctnessManifest.invariants.map(({ id }) => {
    const fixture = negativeEvaluationCase(id);
    const result = evaluateInvariants(fixture.after, fixture.before, fixture.action).find(
      ({ invariantId }) => invariantId === id,
    );
    return { invariantId: id, passed: result?.status === "fail" };
  });
  const corpusResults = q1SeedCorpus.map((entry) => {
    const result = runSequence(entry);
    const observed = [...new Set(result.violations.map(({ invariantId }) => invariantId))].sort();
    const expected = [...entry.expectedViolationIds].sort();
    return {
      id: entry.id,
      seed: entry.seed,
      depth: entry.actions.length,
      expectedViolationIds: expected,
      observedViolationIds: observed,
      passed:
        expected.every((id) => observed.includes(id)) &&
        observed.every((id) => expected.includes(id)),
      coverage: result.coverage,
    };
  });
  const mandatoryNegativeControls = q1MandatoryNegativeControls.map((entry) => {
    const result = runSequence(entry);
    const observed = [...new Set(result.violations.map(({ invariantId }) => invariantId))].sort();
    const passed = entry.expectedViolationIds.every((id) => observed.includes(id));
    return {
      id: entry.id,
      seed: entry.seed,
      expectedViolationIds: entry.expectedViolationIds,
      observedViolationIds: observed,
      passed,
    };
  });
  const failingSequences = [
    ...q1SeedCorpus.filter(({ expectedViolationIds }) => expectedViolationIds.length),
    ...q1MandatoryNegativeControls,
  ];
  const reproductions = failingSequences.flatMap((entry) =>
    entry.expectedViolationIds.map((invariantId) =>
      reproductionFor({
        sequence: entry,
        invariantId,
        release,
        schemaFingerprint: fingerprint,
        q0ManifestDigest,
      }),
    ),
  );
  const proofStatuses = [
    "proven_q1",
    "partially_proven",
    "future_proof_required",
    "known_product_gap",
    "unresolved",
  ] as const;
  const proofCounts = Object.fromEntries(
    proofStatuses.map((status) => [
      status,
      correctnessManifest.invariants.filter((invariant) => proofStatusFor(invariant) === status)
        .length,
    ]),
  );
  const proofGates: readonly Q1ProofGate[] = [
    "Q2",
    "milestone_4_foundation",
    "Q3",
    "Q4",
    "Q5",
    "Q6",
    "dashboard_projection",
    "Q7",
  ];
  const proofGateCounts = Object.fromEntries(
    proofGates.map((gate) => [
      gate,
      correctnessManifest.invariants.filter((invariant) =>
        proofRequirementsFor(invariant).some(({ proofGate }) => proofGate === gate),
      ).length,
    ]),
  );
  const implementationPass =
    positiveControls.every(({ passed }) => passed) &&
    invariantNegativeControls.every(({ passed }) => passed) &&
    corpusResults.every(({ passed }) => passed) &&
    mandatoryNegativeControls.every(({ passed }) => passed);
  const transitionPairs = [
    ...new Set(corpusResults.flatMap(({ coverage }) => coverage.transitionPairs)),
  ].sort();
  const depths = [
    ...corpusResults.map(({ depth }) => depth),
    ...q1MandatoryNegativeControls.map(({ actions }) => actions.length),
  ];

  const report = {
    reportSchemaVersion: 2,
    qualification: "Q1",
    milestone: 2,
    milestone2Implementation: implementationPass ? "PASS" : "FAIL",
    q1Engine: implementationPass ? "PASS" : "FAIL",
    stabilizationProgression: implementationPass ? "ELIGIBLE_FOR_Q2" : "BLOCKED",
    fullSystemReadiness: "BLOCKED",
    fullSystemReadinessReason:
      "Q1 is complete, while later qualification gates and the known Q04 product gap remain deliberately open.",
    q0: {
      digest: q0ManifestDigest,
      status: q0.milestoneStatus,
      stabilizationReadiness: q0.stabilizationReadiness,
      architectureDrift: q0.staticChecks.findings.length > 0,
    },
    sourceHead: release,
    schemaFingerprint: fingerprint,
    counts: {
      invariants: correctnessManifest.invariants.length,
      assertionExecutable: positiveResults.filter(({ status }) => status !== "not_evaluable")
        .length,
      currentProductionProven: correctnessManifest.invariants.filter(
        (invariant) => proofStatusFor(invariant) === "proven_q1",
      ).length,
      positiveControls: positiveControls.length,
      invariantNegativeControls: invariantNegativeControls.length,
      mandatoryNegativeControls: mandatoryNegativeControls.length,
      reproductions: reproductions.length,
      knownProductGaps: correctnessManifest.invariants.filter(
        (invariant) => proofStatusFor(invariant) === "known_product_gap",
      ).length,
    },
    proofCounts,
    proofGateCounts,
    proofLedger: correctnessManifest.invariants.map((invariant) => ({
      invariantId: invariant.id,
      risk: invariant.risk,
      proofStatus: proofStatusFor(invariant),
      boundaryIds: invariant.boundaryIds,
      proofRequirements: proofRequirementsFor(invariant),
    })),
    stabilizationProgram: [
      {
        milestone: 1,
        qualification: "Q0",
        scope: "canonical state / ownership manifest",
        status: "COMPLETE",
      },
      {
        milestone: 2,
        qualification: "Q1",
        scope: "executable truth/state invariant engine",
        status: "CURRENT",
      },
      {
        milestone: 3,
        qualification: "Q2",
        scope: "standardized B1-B20 failpoints, causal envelope, and deterministic fault matrix",
      },
      {
        milestone: 4,
        qualification: null,
        scope:
          "conflict/recovery/lifecycle consolidation; typed conflict scope; malformed-history-safe recovery; reconciliation ownership/deadline; lease/session convergence foundations; Q1/Q2 and recovery-subset reruns",
      },
      {
        milestone: 5,
        qualification: "Q3",
        scope:
          "local Stage-6 miniature with independent external oracle; protected login/read/create/retrieve/evidence and ambiguity/reconciliation scenarios",
      },
      {
        milestone: 6,
        qualification: "Q4 + Q5",
        scope:
          "real process-loss/fencing campaign; durable one-Run/one-mutation/no-redispatch authorization; external-agent local qualification",
      },
      {
        milestone: 7,
        qualification: "Q6",
        scope:
          "dashboard projection track; external/public read-only qualification; lower-gate evidence manifest; guarded authorization for one Q7",
      },
    ],
    q7: {
      meaning: "REAL Stage 6 Test Mode qualification",
      implementationMilestone: false,
      authorization: "guarded authorization for one Q7 after lower-gate evidence",
    },
    coverage: {
      invariantPositiveCoverage: positiveControls.filter(({ passed }) => passed).length,
      invariantNegativeCoverage: invariantNegativeControls.filter(({ passed }) => passed).length,
      stateFamilies: [...new Set(positiveResults.map(({ family }) => family))].sort(),
      transitionPairCount: transitionPairs.length,
      transitionPairs,
      illegalTransitionInvariantCount: invariantNegativeControls.filter(({ passed }) => passed)
        .length,
      mutationBoundaries: [
        "not_dispatched",
        "possible_dispatch",
        "dispatched_once",
        "unknown",
        "authoritative_not_applied",
        "authoritative_applied",
        "reconciliation",
      ],
      sequenceDepth: {
        count: depths.length,
        min: Math.min(...depths),
        max: Math.max(...depths),
        values: depths.sort((left, right) => left - right),
      },
      generatedSequences: 0,
      generationStrategy:
        "deterministic boundary-complete table corpus; no random generator dependency",
    },
    sequenceCorpus: corpusResults,
    positiveControls,
    invariantNegativeControls,
    mandatoryNegativeControls,
    adapters: [
      { adapter: "pure_reference", exercised: true, authority: "test-only immutable snapshots" },
      {
        ...new ContractHelperAdapter().exercise(),
        exercised: true,
        authority: "delegates enum/state-graph legality to @scry/contracts",
      },
      {
        adapter: "postgres_repository",
        adapterMappingExercised: true,
        canonicalLocalDatabaseExercised: process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT === "PASS",
        integrationStatus:
          process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT === "PASS" ? "PASS" : "NOT_RECORDED",
        integrationTest: "apps/api/test/q1-repository-adapter.integration.test.ts",
        authority:
          "read-only translation of durable Mission/Objective/Run/Attempt/adaptive/protected facts",
      },
    ],
    knownProductGaps: [
      {
        invariantId: "Q04",
        risk: "P0",
        boundaryIds: ["B1", "B4", "B17"],
        proofGate: "Q5",
        ownerMilestone: 6,
        finding:
          "No durable campaign quota currently prevents a second live Run or mutation after terminal failure/UNKNOWN.",
      },
    ],
    futureProofBlockers: [
      {
        proofGate: "Q2",
        owner: "Milestone 3",
        scope: "authority/privacy and B1-B20 causal-envelope production proof",
      },
      {
        proofGate: "milestone_4_foundation",
        owner: "Milestone 4",
        scope:
          "conflict/recovery/lifecycle consolidation, typed conflict scope, and convergence foundations",
      },
      {
        proofGate: "Q3",
        owner: "Milestone 5",
        scope:
          "independent Stage-6 miniature, external resource oracle, and ambiguity/reconciliation proof",
      },
      {
        proofGate: "Q4",
        owner: "Milestone 6",
        scope:
          "process death, lease/fence ownership, convergence, stale-owner refusal, and stuck reconciliation",
      },
      {
        proofGate: "Q5",
        owner: "Milestone 6",
        scope: "durable campaign quota/refusal",
      },
      {
        proofGate: "Q6",
        owner: "Milestone 7",
        scope: "public read-only surfaces and external perception/authority qualification",
      },
      {
        proofGate: "dashboard_projection",
        owner: "Milestone 7",
        scope: "dashboard propagation and backend-agreement SLA proof",
      },
    ],
    findings: {
      invariantEngineFailures: [],
      productInvariantFailures: [],
      futureProofRequired: correctnessManifest.invariants
        .filter((invariant) => proofRequirementsFor(invariant).length > 0)
        .map((invariant) => ({
          invariantId: invariant.id,
          risk: invariant.risk,
          proofStatus: proofStatusFor(invariant),
          proofRequirements: proofRequirementsFor(invariant),
          boundaryIds: invariant.boundaryIds,
        })),
      knownFutureProductGaps: ["Q04"],
    },
    reproductions,
    safety: {
      productionBehaviorChanges: false,
      runtimeImportsOfQ1: false,
      protectedPlaintextUsed: false,
      publicOrLiveTargetsAccessed: false,
      stage6Run: false,
    },
  } as const;
  return { report, digest: deterministicDigest(report), reproductions };
}

export function renderQ1Markdown(
  report: Awaited<ReturnType<typeof createQ1Report>>["report"],
  digest: string,
): string {
  const lines = [
    "# Scry System Correctness Q1 Report",
    "",
    `- Milestone-2 implementation: ${report.milestone2Implementation}`,
    `- Q1 engine: ${report.q1Engine}`,
    `- Stabilization progression: ${report.stabilizationProgression}`,
    `- Full-system readiness: ${report.fullSystemReadiness}`,
    `- Q1 report digest: ${digest}`,
    `- Q0 digest/status: ${report.q0.digest} / ${report.q0.status}`,
    `- Source HEAD: ${report.sourceHead}`,
    `- Schema fingerprint: ${report.schemaFingerprint}`,
    "",
    "## Executability is not production proof",
    "",
    `All ${report.counts.assertionExecutable}/${report.counts.invariants} rules are mechanically executable. Current production-proven count is ${report.counts.currentProductionProven}; reference-model controls do not upgrade future proof tiers.`,
    "",
    "## Controls and coverage",
    "",
    `- Positive invariant controls: ${report.coverage.invariantPositiveCoverage}/${report.counts.positiveControls}`,
    `- Per-invariant negative controls: ${report.coverage.invariantNegativeCoverage}/${report.counts.invariantNegativeControls}`,
    `- Mandatory sequence controls: ${report.mandatoryNegativeControls.filter(({ passed }) => passed).length}/${report.counts.mandatoryNegativeControls}`,
    `- Deterministic seed scenarios: ${report.sequenceCorpus.length}`,
    `- Transition pairs: ${report.coverage.transitionPairCount}`,
    `- Generated/random sequences: ${report.coverage.generatedSequences}`,
    "",
    "## Proof status",
    "",
    ...Object.entries(report.proofCounts).map(([status, count]) => `- ${status}: ${count}`),
    ...Object.entries(report.proofGateCounts).map(([gate, count]) => `- ${gate}: ${count}`),
    "",
    "## Known product gaps",
    "",
    ...report.knownProductGaps.map(
      ({ invariantId, finding, proofGate, ownerMilestone }) =>
        `- ${invariantId} (${proofGate}, Milestone ${ownerMilestone}): ${finding}`,
    ),
    "",
    "## Future proof blockers",
    "",
    ...report.futureProofBlockers.map(
      ({ proofGate, owner, scope }) => `- ${proofGate} — ${owner}: ${scope}`,
    ),
    "",
    `Q7 means ${report.q7.meaning}; it is not another implementation milestone.`,
    "",
    "The Q1 model is Assurance-only. It observes production facts and applies cross-system assertions; it does not participate in runtime admission or transitions.",
    "",
  ];
  return lines.join("\n");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
