import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { missionLiveCampaignResultSchema, type MissionLiveCampaignResult } from "@scry/contracts";

const milestone = process.argv[2];
if (milestone !== "M1") throw new Error("MISSION_FIRST_MILESTONE_M1_REQUIRED");
const releaseId = required("SCRY_RELEASE_ID");
const gitCommit = required("SCRY_GIT_COMMIT");
const schemaFingerprint = required("SCRY_SCHEMA_FINGERPRINT");
const runtimeVersion = required("SCRY_RUNTIME_VERSION");
const runtimeConfigurationDigest = createHash("sha256").update(JSON.stringify({
  releaseId, gitCommit, schemaFingerprint, runtimeVersion,
})).digest("hex");
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/runbooks/evidence/mission-first/m1",
);
if (!existsSync(directory)) throw new Error("M1_RELEASE_EVIDENCE_DIRECTORY_REQUIRED");
const failures: string[] = [];
const reports: Array<{ file: string; report: MissionLiveCampaignResult; mtimeMs: number }> = [];
for (const file of readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
  const raw = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
  if (raw.releaseId !== releaseId || raw.schemaVersion !== 2) continue;
  const parsed = missionLiveCampaignResultSchema.safeParse(raw);
  if (!parsed.success) { failures.push(`M1_REPORT_SCHEMA_INVALID:${file}`); continue; }
  if (parsed.data.releaseId === releaseId) reports.push({
    file, report: parsed.data, mtimeMs: statSync(path.join(directory, file)).mtimeMs,
  });
}

const latest = new Map<string, (typeof reports)[number]>();
for (const candidate of reports) {
  const key = `${candidate.report.target}:r${candidate.report.repetition ?? 0}`;
  const current = latest.get(key);
  if (!current || candidate.mtimeMs > current.mtimeMs) latest.set(key, candidate);
}
const admittedReports = [...latest.values()];

for (const { file, report } of admittedReports) {
  const prefix = `M1_REPORT_INVALID:${file}`;
  if (report.gitCommit !== gitCommit || report.schemaFingerprint !== schemaFingerprint ||
      report.runtimeVersion !== runtimeVersion || report.runtimeConfigurationDigest !== runtimeConfigurationDigest)
    failures.push(`${prefix}:RUNTIME_IDENTITY`);
  if (report.requiredChecks.some((check) => check.status !== "passed")) failures.push(`${prefix}:REQUIRED_CHECK`);
  if (report.cleanup.required && report.cleanup.state !== "completed") failures.push(`${prefix}:CLEANUP`);
  if (report.privacyScan.leakedCanaryCount !== 0 || report.privacyScan.checkedByteCount <= 0)
    failures.push(`${prefix}:PRIVACY`);
  const maxPraxisFallbacks = report.target === "xyz_bank" ? 1 : 0;
  if (report.resolution.nativeResolved <= 0 || report.resolution.praxisFallbacks > maxPraxisFallbacks)
    failures.push(`${prefix}:RESOLUTION_RATIO`);
  if (report.reductions.decisionBoundary < 0.7 || report.reductions.mcpCalls < 0.7 ||
      report.reductions.agentBytes < 0.6) failures.push(`${prefix}:REDUCTION_GATE`);
  if (report.calls.repeatedStateReads !== 0 || report.calls.mcp > 2)
    failures.push(`${prefix}:CALL_BUDGET`);
  if (!report.correlationId || !report.missionId || !report.objectiveIds.length || !report.flowIds.length)
    failures.push(`${prefix}:CORRELATION_IDENTITY`);
  for (const phase of ["browser_startup", "document_observation", "native_resolution",
    "interaction_execution", "expected_effect_verification", "evidence_finalization", "artifact_retrieval"])
    if (!report.timings[phase]?.count) failures.push(`${prefix}:TIMING:${phase}`);
}

const production = latest.get("production_shaped:r1");
if (!production) failures.push("M1_PRODUCTION_SHAPED_REPORT_REQUIRED");
else if (production.report.verdict !== "pass") failures.push("M1_PRODUCTION_SHAPED_REPORT_NOT_PASSING");
for (const target of ["vitract_preview", "orangehrm", "expand_testing", "the_internet", "xyz_bank"]) {
  for (const repetition of [1, 2, 3]) {
    const candidate = latest.get(`${target}:r${repetition}`);
    if (!candidate) failures.push(`M1_REPORT_REQUIRED:${target}:r${repetition}`);
    else if (candidate.report.verdict !== "pass") failures.push(`M1_REPORT_NOT_PASSING:${target}:r${repetition}`);
  }
}
if (failures.length) { process.stderr.write(`${[...new Set(failures)].join("\n")}\n`); process.exit(1); }
process.stdout.write(`Mission-first M1 release evidence verified (${admittedReports.length} admitted reports; ${reports.length} retained attempts).\n`);

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
