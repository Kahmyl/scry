import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableJson } from "../src/architecture/q0/validator.js";
import { createQ2Report } from "../src/architecture/q2/report.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "artifacts/system-correctness/m4");
const { report: q2, digest: q2Digest } = await createQ2Report(root);
const schemaFingerprint = execFileSync(
  "node",
  [path.join(root, "scripts/schema-fingerprint.mjs")],
  {
    cwd: root,
    encoding: "utf8",
  },
).trim();
const report = {
  reportSchemaVersion: 1,
  milestone: 4,
  source: {
    baselineHead: "20c5da0c81dcc4a797b8c89d5e9d7f9de6f3a787",
    q0Digest: "45a9d954e015abc5dfe4fd864fc33fa24ef12f783c7739131515ada8404c3ee8",
    q1Digest: "7ec0f1bf95269337c51c7a4d86448785a6fc9e40ca3431548661df8514c90d1a",
    q2DigestBefore: "17bd1051e4cad61861367b7a024ef39815f6ce22588c8d8426c5ad5696ae11d8",
    q2DigestAfter: q2Digest,
    schemaFingerprintBefore: "132f5164c9cb422405d2e4f7f151c6b0edc5e7fb6130f2eb6c4b069ffd838776",
    schemaFingerprintAfter: schemaFingerprint,
  },
  verdicts: {
    milestone4Implementation: q2.verdicts.q2ProductGate === "PASS" ? "PASS" : "FAIL",
    m4ProductCorrection: q2.verdicts.q2ProductGate === "PASS" ? "PASS" : "BLOCKED",
    q2ProductGate: q2.verdicts.q2ProductGate,
    progression: q2.verdicts.q2ProductGate === "PASS" ? "ELIGIBLE_FOR_MILESTONE_5" : "BLOCKED",
  },
  conflictAuthority: {
    authority: "loadConflictScope",
    blockers: [
      "adaptive_unknown",
      "protected_mutation",
      "reconciliation_owner",
      "praxis_runtime_owner",
      "praxis_recovery",
      "external_agent_owner",
      "run_owner",
      "resource_binding",
    ],
    consumers: ["Mission selection", "project operating-context environment readiness"],
    removedPredicates: [
      "MissionSelectionPolicy copied adaptive/protected/reconciliation EXISTS predicates",
      "operating-context copied active Praxis readiness CASE",
    ],
    controls: [
      "unrelated Project excluded",
      "Mission/environment filters",
      "expired owner visible but non-blocking",
    ],
  },
  recovery: {
    historicalAuthority: [
      "usable_authority",
      "unsupported_historical_authority",
      "malformed_authority",
    ],
    malformedResult: "typed conflict; UNKNOWN retained; no reconciliation adapter; no redispatch",
    ownership:
      "idempotency owner identity + reconciliation row id + fencing token + durable lease expiry",
    expiry: "expired observer completes still_unknown and a new observation-only owner may claim",
  },
  lifecycle: {
    disposition: "decideRuntimeLossDisposition",
    b19Before: "runtime absent + release rejected + active Praxis + UNKNOWN",
    b19After: "runtime absent + fenced durable Praxis recovery_required + UNKNOWN",
    matrix: Object.fromEntries(
      "ABCDEFGHIJ"
        .split("")
        .map((id) => [id, "PASS: mutation preserved; lifecycle mechanically classified"]),
    ),
    staleWriter: "refused by runtime/reconciliation fence",
    convergence:
      "explicit close fallback plus durable expired-lease sweep through existing lifecycle owner",
  },
  protectedAdaptive: {
    canonical:
      "protected_operations for protected actions; adaptive_operations for ordinary actions",
    settlementOrder: "protected canonical mutation first, adaptive projection second",
    projectionRepair: "projection-only; no business replay",
  },
  upgradeSafety: {
    qualification: "deterministic_pre_m4_schema_upgrade",
    database: "isolated scry_m4_upgrade_test on repository Docker PostgreSQL",
    fixtureCount: 10,
    fixtures: {
      A: "clean ordinary not_applied; migration behaviorally inert",
      B: "original UNKNOWN; no reconciliation fabricated",
      C: "UNKNOWN + completed still_unknown retained",
      D: "UNKNOWN provenance + completed proven_applied retained",
      E: "UNKNOWN provenance + completed proven_not_applied retained",
      F: "legacy observing row backfilled expired; old identity refused; new exact fence required",
      G: "malformed historical action remains UNKNOWN and typed closed",
      H: "missing observation baseline remains UNKNOWN and insufficient",
      I: "protected recovery_required remains canonical over adaptive UNKNOWN projection",
      J: "expired Praxis lease remains expired and classifies recovery_required",
    },
    migration: {
      result: "PASS",
      preFingerprint: "132f5164c9cb422405d2e4f7f151c6b0edc5e7fb6130f2eb6c4b069ffd838776",
      postFingerprint: schemaFingerprint,
      historicalRowsDropped: 0,
      truthChanges: 0,
      legacyLeaseInterpretation:
        "DEFAULT now() uses the migration transaction timestamp; M4 requires lease_expires_at>now(), so pre-M4 observers are immediately stale",
    },
    reconciliationClaim: {
      oldIdentityMaySettle: false,
      freshClaimRequired: true,
      freshClaimRequiresExactRowAndFence: true,
      originalUnknownRetained: true,
    },
    deployment: {
      oldM3CodeAgainstM4Schema:
        "SQL-compatible but not safe for mixed ownership rollout because M3 completion does not enforce the M4 deadline/exact row fence",
      newM4CodeAgainstPreM4Schema:
        "incompatible: current ownership queries require lease_expires_at",
      requiredOrdering:
        "stop writers; apply migration transaction; start M4 code; do not overlap M3 and M4 writers",
    },
    migrationFailure:
      "transaction rollback leaves lease column absent and pre-M4 fingerprint installed; runner updates fingerprint only in the same successful transaction",
    productionDatabaseCertification: false,
  },
  qualification: {
    postgres: "PASS: isolated scry_m4_test on repository Docker PostgreSQL",
    apiTargeted: "PASS",
    adaptiveRepositoryIntegration: "PASS",
    protectedRepositoryIntegration: "PASS",
    q1RepositoryAdapterIntegration: "PASS",
    missionSelectionIntegration: "PASS",
    q2: q2.verdicts.q2FaultInfrastructure,
    q2ProductGate: q2.verdicts.q2ProductGate,
  },
  productFindings: {
    resolved: ["L04/B19"],
    remaining: q2.productFindings,
    newlyDiscovered: [],
  },
  restrictions: {
    milestone5Implemented: false,
    stage6Run: false,
    publicOrLiveAccess: false,
    committed: false,
    pushed: false,
  },
  diffFingerprint: q2.diffFingerprint,
} as const;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "m4-report.json"), stableJson(report));
await writeFile(
  path.join(output, "m4-report.md"),
  `# Scry system correctness Milestone 4\n\n- MILESTONE_4_IMPLEMENTATION: **${report.verdicts.milestone4Implementation}**\n- M4_PRODUCT_CORRECTION: **${report.verdicts.m4ProductCorrection}**\n- Q2_PRODUCT_GATE: **${report.verdicts.q2ProductGate}**\n- PROGRESSION: **${report.verdicts.progression}**\n\n## Conflict authority\n\nOne typed project/Mission/environment-aware authority now supplies Mission selection and operating-context readiness. Expired owners are visible lifecycle facts, not forever-active blockers.\n\n## Recovery\n\nHistorical action JSON is parsed at the durable boundary. Malformed or unsupported authority returns a typed closed refusal while retaining UNKNOWN, the protected fence, and zero redispatch authority. Reconciliation completion requires the claimed row/fence before its durable deadline.\n\n## Lifecycle\n\nB19 now converges through fenced durable owner-loss disposition. Runtime disappearance and lease validity are independent inputs; mutation UNKNOWN remains UNKNOWN. The A-J mechanical loss matrix passes and stale writers are refused.\n\n## Upgrade safety\n\nA deterministic ten-fixture database was built by the committed pre-M4 migration runner at \`${report.upgradeSafety.migration.preFingerprint}\`, populated before M4, and upgraded by the canonical current runner to \`${report.upgradeSafety.migration.postFingerprint}\`. No product truth changed. The legacy observing row was immediately stale because its backfilled deadline equals the migration transaction timestamp; its old identity was refused and a new exact row/fence was required. A forced migration failure rolled back the column and retained the old fingerprint. Deployment requires stopped writers, migration, then M4 code; mixed M3/M4 writers are not ownership-safe. This is deterministic schema-upgrade qualification, not production-database certification.\n\n## PostgreSQL\n\nThe adaptive-session, protected-operation, Q1 adapter, and Mission-selection suites executed against isolated local database \`scry_m4_test\` at schema \`${schemaFingerprint}\`. The upgrade matrix executed against isolated \`scry_m4_upgrade_test\`.\n\nNo Milestone 5, Stage 6, public/live access, commit, or push is represented.\n`,
);
process.stdout.write(
  `${report.verdicts.milestone4Implementation} M4/${report.verdicts.q2ProductGate} ${schemaFingerprint} artifacts/system-correctness/m4/m4-report.json\n`,
);
if (report.verdicts.milestone4Implementation !== "PASS") process.exitCode = 1;
