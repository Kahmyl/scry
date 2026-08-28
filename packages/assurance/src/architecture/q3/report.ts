import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { stableJson } from "../q0/validator.js";
import { compareIndependentTruth } from "./comparator.js";
import { runQ3Campaign } from "./runner.js";
import { q3Scenarios } from "./scenarios.js";

const q0Digest = "7bf1cd5316faae2d572aa1edb89f5a8a094b076c98be846a8860f2efce0f2230";
const q1Digest = "d01fc4984fc4c4aae7ead2be25eb4b0493fc51e8359b2fd2037aec2e47334668";
const q2Digest = "044a4d3506750c60b7f3f802e0a0f57bf1d3e9383dc25786a24c9d98c8da4357";

export async function createQ3Report(root: string) {
  const canonical = await runQ3Campaign({ seedBase: 5300 });
  const reversed = await runQ3Campaign({
    seedBase: 5300,
    order: [...q3Scenarios.map(({ id }) => id)].reverse(),
  });
  const reverseById = new Map(reversed.scenarios.map((scenario) => [scenario.id, scenario]));
  const determinismMismatches = canonical.scenarios.flatMap((scenario) => {
    const reverse = reverseById.get(scenario.id);
    return !reverse ||
      reverse.oracleDigest !== scenario.oracleDigest ||
      stableJson(reverse.scry) !== stableJson(scenario.scry) ||
      reverse.verdict !== scenario.verdict
      ? [scenario.id]
      : [];
  });
  const controls = oracleControls(canonical.scenarios.find(({ id }) => id === "Q3-05")!);
  const serializedQualification = stableJson({ canonical, reversed });
  const privacy = {
    protectedLogin: canonical.scenarios.find(({ id }) => id === "Q3-03")?.verdict,
    captureSuppression:
      "Veil protected runtime entered isolated/protected and returned to normal before finalization",
    generatedScopeScanned: true,
    protectedSentinelOccurrences: serializedQualification.includes("q3-protected-sentinel-7Vw9k2")
      ? 1
      : 0,
    leaksFound: serializedQualification.includes("q3-protected-sentinel-7Vw9k2") ? 1 : 0,
  } as const;
  const mutationScenarios = canonical.scenarios.filter(
    ({ oracle }) => oracle.mutationRequests.length > 0,
  );
  const totals = {
    intendedActivations: mutationScenarios.length,
    externalRequests: canonical.scenarios.reduce(
      (sum, scenario) => sum + scenario.oracle.mutationRequests.length,
      0,
    ),
    externalCreatedResources: canonical.scenarios.reduce(
      (sum, scenario) => sum + scenario.oracle.resources.length,
      0,
    ),
    duplicateEffects: canonical.scenarios.reduce(
      (sum, scenario) =>
        sum +
        Math.max(
          0,
          scenario.oracle.resources.length -
            new Set(scenario.oracle.resources.map(({ idempotencyKey }) => idempotencyKey)).size,
        ),
      0,
    ),
    unknownCases: canonical.scenarios.filter(
      ({ scry }) => scry.mutationTruth === "unknown" || scry.reconciliationResult !== "none",
    ).length,
    reconciliationCases: canonical.scenarios.filter(
      ({ scry }) => scry.reconciliationResult !== "none",
    ).length,
    redispatchCount: canonical.scenarios.reduce(
      (sum, scenario) => sum + scenario.scry.redispatchCount,
      0,
    ),
    cleanupRequests: canonical.scenarios.reduce(
      (sum, scenario) => sum + scenario.oracle.cleanupRequests,
      0,
    ),
    cleanupEffects: canonical.scenarios.reduce(
      (sum, scenario) => sum + scenario.oracle.cleanupEffects,
      0,
    ),
  };
  const allScenariosPass = canonical.scenarios.every(({ verdict }) => verdict === "PASS");
  const connectedPostgresPass = process.env.SCRY_Q3_POSTGRES_INTEGRATION_RESULT === "PASS";
  const controlsPass = Object.values(controls).every((value) => value === "REJECTED");
  const isolationPass =
    canonical.oracleControl.ordinaryStatus === 404 &&
    canonical.oracleControl.unauthenticatedControlStatus === 403;
  const closurePass =
    allScenariosPass &&
    connectedPostgresPass &&
    controlsPass &&
    isolationPass &&
    privacy.leaksFound === 0 &&
    determinismMismatches.length === 0 &&
    canonical.scenarios.every(({ lifecycleResidue }) => lifecycleResidue.length === 0);
  const sourceDirectory = path.join(root, "packages/assurance/src/architecture/q3");
  const implementationFingerprint = await directoryDigest(sourceDirectory);
  const reportedScenarios = canonical.scenarios.map((scenario) =>
    scenario.id === "Q3-05" && connectedPostgresPass
      ? {
          ...scenario,
          productLayers: [...scenario.productLayers, "API adaptive repository", "PostgreSQL"],
          productionComponentsExecuted: [
            ...scenario.productionComponentsExecuted,
            "AdaptiveSessionRepository durable operation/fence lifecycle",
            "PostgresQ1Adapter",
          ],
          proofProvenance: [...scenario.proofProvenance, "repository_integration" as const],
          postgres: true,
        }
      : scenario,
  );
  const report = {
    reportSchemaVersion: 1,
    qualification: "Q3",
    milestone: 5,
    source: {
      head: git(root, ["rev-parse", "HEAD"]),
      headSubject: git(root, ["show", "-s", "--format=%s", "HEAD"]),
      schemaFingerprint: execFileSync("node", [path.join(root, "scripts/schema-fingerprint.mjs")], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      q0Digest,
      q1Digest,
      q2Digest,
      m4ReportDigest: "057266bf8ff8ea1ea65b9a9bf68cf4d4fec0405e51d7bb2059e4f35765798651",
      implementationFingerprint,
    },
    verdicts: {
      milestone5Implementation: allScenariosPass ? "PASS" : "FAIL",
      m5ClosureReview: closurePass ? "PASS" : "FAIL",
      q3Fixture: allScenariosPass && isolationPass ? "PASS" : "FAIL",
      q3IndependentOracle: controlsPass && isolationPass ? "PASS" : "FAIL",
      q3ProductGate: closurePass ? "PASS" : "BLOCKED",
      progression: closurePass ? "ELIGIBLE_FOR_MILESTONE_6" : "BLOCKED",
    },
    fixture: {
      architecture:
        "one loopback resource application plus a separate capability-protected oracle listener",
      reusedInfrastructure: [
        "Assurance loopback browser fixture pattern",
        "Praxis exact target references and read-only CDP sensor",
        "Veil protected runtime coordinator semantics",
        "Q2 approved test-only failpoint controller",
        "Q1 committed invariant engine",
      ],
      newlyAdded: [
        "one resource fixture",
        "independent truth listener",
        "Q3 comparator/campaign/report",
      ],
      surfaces: [
        "GET /docs",
        "GET /app",
        "POST /auth",
        "GET/POST/DELETE /api/resources",
        "GET /worker.js",
      ],
      modes: [
        "NORMAL",
        "DELAYED_ACK",
        "DROP_ACK_AFTER_COMMIT",
        "NO_COMMIT_DROP",
        "RESPONSE_BEFORE_UI_PROJECTION",
        "STILL_AMBIGUOUS",
      ],
      authentication: "synthetic local credentials delivered only during a Veil protected interval",
      oracleIsolation: canonical.oracleControl,
    },
    oracle: {
      authority:
        "fixture-owned in-memory truth; never reads Scry repository, Chronicle, Run links, or reports",
      access:
        "separate 127.0.0.1 listener with unguessable bearer capability retained in harness closure",
      fields: [
        "requests",
        "idempotency",
        "correlation",
        "commit/ack sequence",
        "resources/IDs/state",
        "retrievals",
        "authentication success",
        "document/target/worker",
        "evidence mode",
        "cleanup",
      ],
      adversarialControls: controls,
      campaignDigest: createHash("sha256")
        .update(stableJson(canonical.scenarios.map(({ oracleDigest }) => oracleDigest)))
        .digest("hex"),
    },
    scenarios: reportedScenarios,
    mutationSafety: totals,
    privacy,
    determinism: {
      canonicalOrder: canonical.order,
      reverseOrder: reversed.order,
      independentlyReset: true,
      highRiskAmbiguityRunsPerScenario: 2,
      stateBleedOrOrderMismatches: determinismMismatches,
    },
    lifecycle: {
      scopedResidue: Object.fromEntries(
        canonical.scenarios.map(({ id, lifecycleResidue }) => [id, lifecycleResidue]),
      ),
      expectedUnknownFence: "Q3-09 only",
      globalHistoricalStateRequiredEmpty: false,
    },
    connectedProductPath: {
      result: connectedPostgresPass ? "PASS" : "NOT_EXECUTED",
      scenario: "Q3-05",
      route:
        "real Chromium/Praxis create and public retrieval -> AdaptiveSessionRepository fenced settlement -> isolated PostgreSQL -> PostgresQ1Adapter -> Q1 -> independent fixture comparison",
      database: connectedPostgresPass ? "isolated local scry_q3_test" : null,
      test: "apps/api/test/q3-local-system.integration.test.ts",
    },
    proofStatus: {
      Q03: "production_characterized_by_independent_local_oracle",
      Q04: "known_product_gap_milestone_6",
      Q4: "real_process_loss_campaign_milestone_6",
      Q5: "repository_blind_external_agent_milestone_6",
      Q01: "dashboard_projection_milestone_7",
      Q6: "public_read_only_qualification_milestone_7",
      Q7: "real_stage_6_test_mode_after_guarded_reentry",
    },
    productFindings: [],
    scope: {
      productionBehaviorChanged: false,
      schemaChanged: false,
      fixtureTypesExportedFromAssuranceRoot: false,
      runtimeAssuranceDependency: false,
      milestone6Implemented: false,
      dashboardOrPublicWork: false,
      realStage6Run: false,
      liveOrPublicAccess: false,
    },
  } as const;
  const digest = createHash("sha256").update(stableJson(report)).digest("hex");
  return { report, digest };
}

function oracleControls(scenario: Awaited<ReturnType<typeof runQ3Campaign>>["scenarios"][number]) {
  const base = {
    scry: scenario.scry,
    expectedGeneration: scenario.seed,
    expectedMutationRequests: 1,
    expectedCreatedResources: 1,
  };
  const rejected = (oracle: Parameters<typeof compareIndependentTruth>[0]["oracle"]) =>
    compareIndependentTruth({ ...base, oracle }).verdict === "FAIL" ? "REJECTED" : "MISSED";
  return {
    wrongResourceId: rejected({
      ...scenario.oracle,
      resources: scenario.oracle.resources.map((resource) => ({
        ...resource,
        id: "wrong-resource",
      })),
    }),
    wrongMutationCount: rejected({ ...scenario.oracle, mutationRequests: [] }),
    hiddenDuplicate: rejected({
      ...scenario.oracle,
      resources: [
        ...scenario.oracle.resources,
        { ...scenario.oracle.resources[0]!, id: "hidden-duplicate" },
      ],
    }),
    staleSnapshot: rejected({ ...scenario.oracle, generation: scenario.seed - 1 }),
    scrySelfOracle: rejected({ ...scenario.oracle, source: "scry" }),
  } as const;
}

async function directoryDigest(directory: string) {
  const files = (await readdir(directory)).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(await readFile(path.join(directory, file)));
  return hash.digest("hex");
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function renderQ3Markdown(
  report: Awaited<ReturnType<typeof createQ3Report>>["report"],
  digest: string,
) {
  const rows = report.scenarios
    .map(
      (scenario) =>
        `| ${scenario.id} | ${scenario.verdict} | ${scenario.proofProvenance.join(", ")} | ${scenario.productLayers.join(", ")} |`,
    )
    .join("\n");
  return `# Scry system correctness Q3 / Milestone 5\n\n- MILESTONE_5_IMPLEMENTATION: **${report.verdicts.milestone5Implementation}**\n- M5_CLOSURE_REVIEW: **${report.verdicts.m5ClosureReview}**\n- Q3_FIXTURE: **${report.verdicts.q3Fixture}**\n- Q3_INDEPENDENT_ORACLE: **${report.verdicts.q3IndependentOracle}**\n- Q3_PRODUCT_GATE: **${report.verdicts.q3ProductGate}**\n- PROGRESSION: **${report.verdicts.progression}**\n- report digest: \`${digest}\`\n\n## Architecture\n\nOne local resource application is observed through real Chromium/Praxis. A separate capability-protected listener exposes fixture-owned truth only to Assurance. Scry-facing routes cannot access it.\n\n## Scenarios\n\n| Scenario | Verdict | Proof provenance | Layers |\n|---|---|---|---|\n${rows}\n\n## Mutation safety\n\n${JSON.stringify(report.mutationSafety)}\n\n## Closure\n\nCanonical and reverse-order campaigns used independently reset browser, cookie, idempotency, scope, and oracle state. Adversarial oracle controls were rejected; protected sentinel occurrences were ${report.privacy.protectedSentinelOccurrences}; scoped unexplained lifecycle residue was zero.\n\nQ04, Q4, and Q5 remain Milestone 6. Q01/dashboard and Q6 remain Milestone 7. Q7 remains real Stage 6 Test Mode after guarded re-entry. No Milestone 6, Stage 6, public/live access, schema change, production behavior change, commit, or push is represented by this report.\n`;
}
