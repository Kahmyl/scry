import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ledger = JSON.parse(readFileSync("docs/architecture/veil-readiness-ledger.json", "utf8"));
const index = JSON.parse(
  readFileSync("docs/architecture/evidence/veil-campaign-evidence.json", "utf8"),
);
const code = JSON.parse(
  execFileSync("node", ["scripts/veil-readiness-manifest.mjs"], { encoding: "utf8" }),
);
const evidence = JSON.parse(
  execFileSync("node", ["scripts/veil-evidence-manifest.mjs"], { encoding: "utf8" }),
);
const failures = [];
const identity = ledger.releaseIdentity;

compare("base commit", identity.baseCommit, code.baseCommit);
compare("branch", identity.branch, code.branch);
compare(
  "tracked code manifest",
  identity.codeTrackedDiffSha256ExcludingSignoffArtifacts,
  code.trackedDiffSha256,
);
compare(
  "untracked code manifest",
  identity.codeUntrackedContentManifestSha256ExcludingSignoffArtifacts,
  code.untrackedPathContentManifestSha256,
);
compare(
  "code entry count",
  identity.codeWorkingTreeEntryCountExcludingSignoffArtifacts,
  code.codeWorkingTreeEntryCount,
);
compare("evidence manifest", identity.evidenceManifestSha256, evidence.digest);
compare("evidence entry count", identity.evidenceManifestEntryCount, evidence.entries.length);

for (const report of index.reports.filter((entry) => entry.artifact)) {
  const bytes = readFileSync(report.artifact);
  const digest = createHash("sha256").update(bytes).digest("hex");
  compare(`${report.id} report digest`, report.reportSha256, digest);
  const parsed = JSON.parse(bytes);
  if (parsed.exitCode !== undefined && parsed.exitCode !== 0)
    failures.push(`${report.id} command exited with ${parsed.exitCode}`);
  if (parsed.exitStatus !== undefined && parsed.exitStatus !== 0)
    failures.push(`${report.id} command exited with ${parsed.exitStatus}`);
  if (parsed.counts && (parsed.counts.failed !== 0 || parsed.counts.skipped !== 0))
    failures.push(`${report.id} has failed or skipped scenarios`);
  if (report.status !== "passed") failures.push(`${report.id} is not recorded as passed`);
}

if (failures.length) {
  console.error(
    `Veil release evidence verification failed:\n${failures.map((x) => `- ${x}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `Veil release evidence verified: ${index.reports.length} reports, ${evidence.entries.length} evidence entries, and current code manifests match the ledger.`,
);

function compare(label, recorded, actual) {
  if (recorded !== actual)
    failures.push(`${label} is stale (recorded ${recorded}, actual ${actual})`);
}
