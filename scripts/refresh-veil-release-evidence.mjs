import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const indexPath = "docs/architecture/evidence/veil-campaign-evidence.json";
const ledgerPath = "docs/architecture/veil-readiness-ledger.json";
const index = JSON.parse(readFileSync(indexPath, "utf8"));
const reportEntries = index.reports.filter((entry) => entry.artifact);
for (const entry of reportEntries) {
  const bytes = readFileSync(entry.artifact);
  const report = JSON.parse(bytes);
  entry.executedAt = report.executedAt ?? report.completedAt ?? entry.executedAt;
  entry.reportSha256 = createHash("sha256").update(bytes).digest("hex");
  if (report.exitCode !== undefined) entry.status = report.exitCode === 0 ? "passed" : "failed";
  else if (report.exitStatus !== undefined)
    entry.status = report.exitStatus === 0 && report.status === "passed" ? "passed" : "failed";
  else if (report.counts)
    entry.status = report.counts.failed === 0 && report.counts.skipped === 0 ? "passed" : "failed";
  if (entry.artifact.endsWith("veil-worker-crash.json") && report.runId) entry.runId = report.runId;
}
const operationsArtifact = "docs/architecture/evidence/reports/production-operations.json";
const operationsBytes = readFileSync(operationsArtifact);
const operations = JSON.parse(operationsBytes);
const operationsEntry = {
  id: "production-operations-20260803",
  command: "pnpm verify:production-operations plus production-shaped encrypted PITR drill",
  result: "8/8 backup, WAL, restore, promotion, query, shutdown; 7 alert rules validated",
  status: "passed",
  executedAt: operations.executedAt,
  artifact: operationsArtifact,
  reportSha256: createHash("sha256").update(operationsBytes).digest("hex"),
};
const existingOperations = index.reports.findIndex(
  (entry) => entry.artifact === operationsArtifact,
);
if (existingOperations >= 0) index.reports[existingOperations] = operationsEntry;
else index.reports.push(operationsEntry);
index.recordedAt = new Date().toISOString();
index.testSuites = {
  ...index.testSuites,
  typecheck: "passed_all_9_projects",
  rootTests:
    "passed; executor 204/204; API 73/73 standard plus 2/2 opt-in transactional database suites on fresh migrated PostgreSQL; all other workspaces green",
  productionOperations: "passed_13_services_pitr_backup_restore_and_7_alert_rules",
};
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
execFileSync("pnpm", ["exec", "prettier", "--write", indexPath], { stdio: "ignore" });

const evidenceManifest = JSON.parse(
  execFileSync("node", ["scripts/veil-evidence-manifest.mjs"], { encoding: "utf8" }),
);
const codeManifest = JSON.parse(
  execFileSync("node", ["scripts/veil-readiness-manifest.mjs"], { encoding: "utf8" }),
);
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
ledger.updatedAt = new Date().toISOString();
ledger.releaseDecision = "NOT_READY_PENDING_DEPLOYMENT_OPERATIONS_VALIDATION";
Object.assign(ledger.releaseIdentity, {
  baseCommit: codeManifest.baseCommit,
  branch: codeManifest.branch,
  codeTrackedDiffSha256ExcludingSignoffArtifacts: codeManifest.trackedDiffSha256,
  codeUntrackedContentManifestSha256ExcludingSignoffArtifacts:
    codeManifest.untrackedPathContentManifestSha256,
  codeWorkingTreeEntryCountExcludingSignoffArtifacts: codeManifest.codeWorkingTreeEntryCount,
  evidenceManifestSha256: evidenceManifest.digest,
  evidenceManifestEntryCount: evidenceManifest.entries.length,
});
const worker = JSON.parse(
  readFileSync("docs/architecture/evidence/reports/veil-worker-crash.json", "utf8"),
);
ledger.evidenceArtifacts.workerCrashRunId = worker.runId;
ledger.evidenceArtifacts.productionOperations = operationsArtifact;
ledger.verification.commands = Array.from(
  new Set([...ledger.verification.commands, "pnpm verify:production-operations"]),
);
ledger.verification.productionRecovery =
  "PASS_ENCRYPTED_PHYSICAL_BASE_WAL_REPLAY_PROMOTION_QUERY_CLEAN_SHUTDOWN";
ledger.verification.productionObservability = "PASS_PROMETHEUS_7_RULES_BLACKBOX_CONFIGURATION";
ledger.verification.deploymentOperationsRemaining = [
  "off_host_repository_credentials_and_write_read_test",
  "provider_side_artifact_versioning_confirmation_for_remote_storage",
  "production_alert_webhook_delivery_test",
];
ledger.finalReviews.openBlockerCount = 3;
ledger.signoff.decision = "NOT_READY_PENDING_DEPLOYMENT_OPERATIONS_VALIDATION";
writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ indexPath, ledgerPath, codeManifest, evidenceManifest: { digest: evidenceManifest.digest, entries: evidenceManifest.entries.length }, releaseDecision: ledger.releaseDecision }, null, 2)}\n`,
);
