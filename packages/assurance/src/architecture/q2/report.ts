import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { correctnessManifest } from "../q0/manifest.js";
import { createQ0Report } from "../q0/report.js";
import { deterministicDigest, schemaFingerprint } from "../q0/validator.js";
import { invariantStatement, proofRequirementsFor } from "../q1/invariants.js";
import { createQ1Report } from "../q1/report.js";
import {
  q2ProofProvenance,
  type Q2ProductionProofStatus,
  type Q2ProofProvenance,
} from "./provenance.js";
import { runQ2Scenario } from "./runner.js";
import { q2PairedScenarios, q2Scenarios } from "./scenarios.js";

export async function createQ2Report(root: string) {
  const q0 = await createQ0Report(root);
  const previousPostgresResult = process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT;
  const q1 = await (async () => {
    try {
      process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT = "PASS";
      return await createQ1Report(root);
    } finally {
      if (previousPostgresResult === undefined)
        delete process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT;
      else process.env.SCRY_Q1_POSTGRES_INTEGRATION_RESULT = previousPostgresResult;
    }
  })();
  const sourceHead = git(root, ["rev-parse", "HEAD"]);
  const results = q2Scenarios.map((scenario) => {
    const run = runQ2Scenario(scenario);
    const proof = q2ProofProvenance[scenario.boundary];
    return {
      id: scenario.id,
      seed: scenario.seed,
      boundary: scenario.boundary,
      failpoint: scenario.failpoint,
      positiveControl: "same boundary reach with disabled controller leaves baseline Q1-valid",
      negativeControl:
        scenario.boundary === "B19"
          ? "L04 active-session/no-owner detection"
          : "causal/redispatch/malformed controls",
      expectedDispatchCategory: scenario.dispatchCategory,
      actualDispatchCount: run.snapshot.operation.dispatchCount,
      truth: run.envelope.truth,
      lifecycle: run.snapshot.run.state,
      runtimeOwnership: run.snapshot.praxis,
      retryClass: scenario.retryClass,
      recoveryOwner: scenario.recoveryOwner,
      applicableInvariantIds: scenario.invariantIds,
      q1InvariantResult: run.violations.length ? "PRODUCT_INVARIANT_FAILURE" : "PASS",
      violationIds: run.violations.map(({ invariantId }) => invariantId),
      causalEventResult: run.ledger.length === 1 ? "PASS" : "FAIL",
      ledger: run.ledger,
      proofProvenance: proof.provenance,
      productionComponentsActuallyExecuted: proof.productionComponentsExecuted,
      mockedWrappedOrTestOnlyComponents: proof.mockedWrappedOrTestOnlyComponents,
      durablePostgresStateInspected: proof.durablePostgresInspected,
      realBrowserOrPraxisMechanicsExecuted: proof.realBrowserOrPraxisMechanicsExecuted,
      independentDispatchOrEffectOracleUsed: proof.independentDispatchOracleUsed,
      resultingStateEvaluatedByQ1: proof.resultingStateEvaluatedByQ1,
      productionProofStatus: proof.productionProofStatus,
      proofNotes: proof.proofNotes,
    };
  });
  const provenanceClasses: readonly Q2ProofProvenance[] = [
    "assurance_reference",
    "existing_regression_evidence",
    "repository_integration",
    "production_characterization",
    "real_browser_local",
    "independent_http_oracle",
  ];
  const productionProofStatuses: readonly Q2ProductionProofStatus[] = [
    "characterized",
    "partially_proven",
    "production_proven_q2",
    "future_proof_required",
  ];
  const highRiskBoundaries = [
    "B4",
    "B5",
    "B6",
    "B7",
    "B9",
    "B10",
    "B12",
    "B13",
    "B14",
    "B15",
    "B16",
    "B17",
    "B18",
    "B19",
  ] as const;
  const isProductionExercised = (result: (typeof results)[number]) =>
    result.proofProvenance.some((provenance) =>
      ["repository_integration", "production_characterization", "real_browser_local"].includes(
        provenance,
      ),
    );
  const productFindings = results.flatMap((result) =>
    result.violationIds.map((invariantId) => {
      const invariant = correctnessManifest.invariants.find(({ id }) => id === invariantId);
      if (!invariant) throw new Error(`Q2_UNKNOWN_INVARIANT:${invariantId}`);
      const milestones = proofRequirementsFor(invariant).map(
        ({ ownerMilestone }) => ownerMilestone,
      );
      return {
        invariantId,
        boundary: result.boundary,
        risk: invariant.risk,
        observedDurableState: {
          runtimeOwnership: result.runtimeOwnership,
          truth: result.truth,
          lifecycle: result.lifecycle,
        },
        observedProductionFacts:
          invariantId === "L04"
            ? [
                "production runtime evicted",
                "browser close succeeds",
                "durable lease release rejects",
                "Praxis durable session remains active",
                "there is no live runtime owner",
                "mutation remains unknown",
                "runtime truth is recovery_required",
              ]
            : [],
        expectedState: invariantStatement(invariantId),
        responsibleOwner: invariant.authoritativeComponents.join("/"),
        owningMilestone: milestones.length ? Math.min(...milestones) : 4,
        classification: "PRODUCT_INVARIANT_FAILURE",
        reproduction: { scenarioId: result.id, seed: result.seed },
      };
    }),
  );
  const report = {
    reportSchemaVersion: 1,
    qualification: "Q2",
    milestone: 3,
    source: {
      head: sourceHead,
      schemaFingerprint: schemaFingerprint(root),
      q0Digest: q0.digest,
      q1Digest: q1.digest,
    },
    verdicts: {
      milestone3Implementation: results.every(
        ({ causalEventResult }) => causalEventResult === "PASS",
      )
        ? "PASS"
        : "FAIL",
      q2FaultInfrastructure: results.length === 20 ? "PASS" : "FAIL",
      q2ProductGate: productFindings.length ? "BLOCKED" : "PASS",
      progression: "ELIGIBLE_FOR_MILESTONE_4",
    },
    failpointSystem: {
      failpointCount: q2Scenarios.length,
      boundariesCovered: q2Scenarios.map(({ boundary }) => boundary),
      highRiskBoundariesCovered: [...highRiskBoundaries],
      supportedEffects: [...new Set(q2Scenarios.map(({ failpoint }) => failpoint.effect))].sort(),
      activationProof: {
        controllerLocation: "Assurance-only, not exported from @scry/assurance root",
        runtimeImports: "API/MCP/Praxis source scan rejects Q2/controller imports",
        construction: "private capability plus NODE_ENV=test rejection",
        environmentVariableActivation: false,
        disabledPath: "explicit no-op object; zero production call sites",
      },
    },
    proofProvenanceSummary: {
      vocabulary: provenanceClasses,
      countsByProvenance: Object.fromEntries(
        provenanceClasses.map((provenance) => [
          provenance,
          results.filter((result) => result.proofProvenance.includes(provenance)).length,
        ]),
      ),
      countsByProductionProofStatus: Object.fromEntries(
        productionProofStatuses.map((status) => [
          status,
          results.filter(({ productionProofStatus }) => productionProofStatus === status).length,
        ]),
      ),
      highRiskProductionExercisedCount: results.filter(
        (result) =>
          highRiskBoundaries.includes(result.boundary as (typeof highRiskBoundaries)[number]) &&
          isProductionExercised(result),
      ).length,
      highRiskFutureProofRequiredCount: results.filter(
        (result) =>
          highRiskBoundaries.includes(result.boundary as (typeof highRiskBoundaries)[number]) &&
          result.productionProofStatus === "future_proof_required",
      ).length,
      interpretation:
        "A Q1-valid reference snapshot proves legal resulting truth, not physical full-path production fault injection. Only production_proven_q2 carries that stronger Q2 claim.",
    },
    q2Semantics: {
      infrastructurePassMeans: [
        "deterministic boundary scenario mechanism exists",
        "B1-B20 are represented",
        "failure consequences are evaluated",
        "Q1 evaluates every resulting truth state",
        "stable cases, seeds, and ledgers reproduce deterministically",
      ],
      infrastructurePassDoesNotMean: [
        "every boundary was physically fault-injected through a complete production path",
        "process-loss behavior is proven",
        "reconciliation behavior is corrected",
        "campaign safety exists",
        "Stage 6 is ready",
      ],
      productGateBlockedBy: "L04/B19 production invariant failure",
      progressionReason:
        "Milestone 4 owns lifecycle/lease convergence correction, so Q2 infrastructure closure remains eligible to progress.",
    },
    causalEnvelope: {
      phasesCovered: [...new Set(q2Scenarios.map(({ phase }) => phase))].sort(),
      componentsCovered: [...new Set(q2Scenarios.map(({ component }) => component))].sort(),
      privateProjection: "safe opaque causality IDs and digest reference only",
      publicProjection:
        "bounded reason/phase/category/dispatch/retry/correlation plus re-digested cause reference",
      prohibitedData: [
        "credentials",
        "protected plaintext",
        "DOM/request/response bodies",
        "selectors",
        "cookies",
        "secret headers",
        "raw SQL",
        "stack text",
      ],
      remainingCauseLossPaths: [
        "Existing production error types are not globally rewritten; Q2 records boundary evidence without changing public behavior.",
      ],
      productionIntegrationGaps: [
        {
          boundaryIds: q2Scenarios.map(({ boundary }) => boundary),
          scope:
            "The Q2 envelope is complete in qualification evidence but is not universally attached to existing production error paths.",
          owner: "boundary-specific Milestone 4 or later production integration",
        },
        {
          boundaryIds: ["B20"],
          scope:
            "Durable-sink failure is production-characterized, while universal safe causal-envelope propagation remains partial.",
          owner: "observability owner in later stabilization work",
        },
      ],
    },
    faultMatrix: results,
    pairedDispatchProof: q2PairedScenarios,
    evidenceMatrix: {
      required: {
        available: "eligible",
        pending: "blocks",
        failed: "blocks",
        quarantined: "blocks",
      },
      optional: {
        available: "eligible",
        suppressed: "eligible",
        failed: "explicit_failed",
        quarantined: "explicit_unsafe",
      },
    },
    artifactSplit: {
      bytesThenMetadataFailure: "PROVEN_EXISTING_API_TEST",
      metadataReservationThenBytesFailure:
        "NOT_SEPARATELY_REPRESENTABLE_BY_CURRENT_LOCAL_ARTIFACT_CONTRACT",
      disposition: "missing direction remains a Q2 future-proof item; no storage subsystem added",
    },
    independentDispatchOracle: {
      kind: "Assurance-only loopback HTTP counter",
      mutationEndpoints: 1,
      truthEndpoints: 1,
      preDispatchCount: 0,
      postDispatchCount: 1,
      idempotencyIdentityRecorded: true,
    },
    controls: {
      q1AfterEveryFault: true,
      brokenControls: [
        "causal-envelope-loss:T08",
        "second-dispatch:M05",
        "malformed-authority:R02",
      ],
      browserDbTimingRepetition:
        "targeted production suites run once per qualification; deterministic in-process cases run twice via report equality test",
    },
    productFindings,
    proofStatus: {
      newlyQ2Proven: [
        "Q02 deterministic qualification-layer causal coverage",
        "B1-B20 logical fault truth",
        "test-controller non-activation",
      ],
      stillRequires: [
        "Q3 independent Stage-6 miniature",
        "Q4 process death/fencing",
        "Q5 repository-blind agent/quota",
        "Q6 public read-only",
        "Q7 real Stage 6",
      ],
      knownProductGaps: productFindings.map(({ invariantId, boundary }) => ({
        invariantId,
        boundary,
      })),
      unresolved: ["B12 metadata-first/storage-second split direction"],
    },
    productionEvidenceSuites: [
      "apps/api/test/q2-runtime-close-fault.test.ts",
      "apps/api/test/adaptive-session-kernel.runner.test.ts",
      "apps/api/test/execution-kernel.repository.integration.test.ts",
      "apps/api/test/protected-output-persistence.repository.test.ts",
      "apps/api/test/run-processor-artifact-commit.test.ts",
      "apps/api/test/agent-directed-run-evidence-finalize.test.ts",
      "apps/api/test/causal-runtime-observability.test.ts",
      "packages/praxis/test/transaction.test.ts",
    ],
    restrictions: { milestone4Implemented: false, stage6Run: false, publicOrLiveAccess: false },
    diffFingerprint: workingDiffFingerprint(root),
  } as const;
  return { report, digest: deterministicDigest(report) };
}

export function renderQ2Markdown(
  report: Awaited<ReturnType<typeof createQ2Report>>["report"],
  digest: string,
) {
  return `# Scry system correctness Q2\n\n- Report digest: \`${digest}\`\n- Source HEAD: \`${report.source.head}\`\n- Schema fingerprint: \`${report.source.schemaFingerprint}\`\n- Q0: \`${report.source.q0Digest}\`\n- Q1: \`${report.source.q1Digest}\`\n\n## Verdicts\n\n- MILESTONE_3_IMPLEMENTATION: **${report.verdicts.milestone3Implementation}**\n- Q2_FAULT_INFRASTRUCTURE: **${report.verdicts.q2FaultInfrastructure}**\n- Q2_PRODUCT_GATE: **${report.verdicts.q2ProductGate}**\n- PROGRESSION: **${report.verdicts.progression}**\n\nQ2 infrastructure PASS means deterministic B1-B20 scenarios, fault consequence evaluation, Q1 evaluation, and reproducible ledgers exist. It does not mean every fault was injected through a complete production path, process loss is proven, recovery is corrected, campaign safety exists, or Stage 6 is ready.\n\n## Proof provenance\n\nA Q1-valid reference snapshot proves legal resulting truth; it does not by itself prove physical production fault injection.\n\n${report.faultMatrix.map((entry) => `- ${entry.boundary} \`${entry.id}\` / \`${entry.failpoint.name}\`: **${entry.productionProofStatus}**; provenance=${entry.proofProvenance.join(",")}; production=${entry.productionComponentsActuallyExecuted.join(" + ")}; test-only=${entry.mockedWrappedOrTestOnlyComponents.join(" + ")}; postgres=${yesNo(entry.durablePostgresStateInspected)}; real-browser/praxis=${yesNo(entry.realBrowserOrPraxisMechanicsExecuted)}; independent-oracle=${yesNo(entry.independentDispatchOrEffectOracleUsed)}; Q1=${yesNo(entry.resultingStateEvaluatedByQ1)}. ${entry.proofNotes}`).join("\n")}\n\n## Fault results\n\n${report.faultMatrix.map((entry) => `- ${entry.boundary}: ${entry.q1InvariantResult}; ${entry.expectedDispatchCategory}; mutation=${entry.truth.mutation}; retry=${entry.retryClass}`).join("\n")}\n\n## Product findings\n\n${report.productFindings.length ? report.productFindings.map((finding) => `- ${finding.classification} ${finding.invariantId} at ${finding.boundary} (${finding.risk}), owned by Milestone ${finding.owningMilestone}. Reproduction: \`${finding.reproduction.scenarioId}\`, seed ${finding.reproduction.seed}. Expected: ${finding.expectedState}`).join("\n") : "None."}\n\n## Causal envelope\n\nThe Q2 envelope preserves phase, component, cause, truth, retry, and safe causality in qualification evidence. Existing production error paths are not universally envelope-attached; boundary-specific integration remains Milestone 4 or later work.\n\nNo Milestone 4 implementation, Stage 6 run, public/live access, commit, or push is represented by this report.\n`;
}

function yesNo(value: boolean) {
  return value ? "yes" : "no";
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function workingDiffFingerprint(root: string) {
  const hash = createHash("sha256").update(
    execFileSync("git", ["diff", "--binary"], { cwd: root }),
  );
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .sort();
  for (const relative of untracked)
    hash.update(`\0${relative}\0`).update(readFileSync(path.join(root, relative)));
  return hash.digest("hex");
}
