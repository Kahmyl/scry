import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { missionLiveCampaignResultSchema, type MissionLiveCampaignResult } from "@scry/contracts";

const releaseId = required("SCRY_RELEASE_ID");
const gitCommit = required("SCRY_GIT_COMMIT");
const schemaFingerprint = required("SCRY_SCHEMA_FINGERPRINT");
const runtimeVersion = required("SCRY_RUNTIME_VERSION");
const runtimeConfigurationDigest = createHash("sha256").update(JSON.stringify({
  releaseId, gitCommit, schemaFingerprint, runtimeVersion,
})).digest("hex");
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/runbooks/evidence/mission-first/m2",
);
if (!existsSync(directory)) throw new Error("M2_RELEASE_EVIDENCE_DIRECTORY_REQUIRED");

const failures: string[] = [];
const reports: Array<{ file: string; report: MissionLiveCampaignResult; mtimeMs: number }> = [];
for (const file of readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
  const raw = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
  if (raw.releaseId !== releaseId || raw.milestone !== "M2") continue;
  const parsed = missionLiveCampaignResultSchema.safeParse(raw);
  if (!parsed.success) {
    failures.push(`M2_REPORT_SCHEMA_INVALID:${file}`);
    continue;
  }
  reports.push({ file, report: parsed.data, mtimeMs: statSync(path.join(directory, file)).mtimeMs });
}

const latest = new Map<string, (typeof reports)[number]>();
for (const candidate of reports) {
  const key = `${candidate.report.target}:r${candidate.report.repetition}`;
  const current = latest.get(key);
  if (!current || candidate.mtimeMs > current.mtimeMs) latest.set(key, candidate);
}

for (const { file, report } of latest.values()) {
  const prefix = `M2_REPORT_INVALID:${file}`;
  if (report.gitCommit !== gitCommit || report.schemaFingerprint !== schemaFingerprint ||
      report.runtimeVersion !== runtimeVersion ||
      report.runtimeConfigurationDigest !== runtimeConfigurationDigest)
    failures.push(`${prefix}:RUNTIME_IDENTITY`);
  if (report.verdict !== "pass" || report.requiredChecks.some((check) => check.status !== "passed"))
    failures.push(`${prefix}:REQUIRED_CHECK`);
  if (report.cleanup.required && report.cleanup.state !== "completed") failures.push(`${prefix}:CLEANUP`);
  if (report.privacyScan.leakedCanaryCount !== 0 || report.privacyScan.checkedByteCount <= 0)
    failures.push(`${prefix}:PRIVACY`);
  if (report.objectiveIds.length < 3 || report.flowIds.length < 3 ||
      new Set(report.flowIds).size !== report.flowIds.length)
    failures.push(`${prefix}:MISSION_FLOW_COUNT`);
  if (report.resolution.nativeResolved <= 0 || report.resolution.praxisFallbacks !== 0)
    failures.push(`${prefix}:NATIVE_ONLY`);
  if (report.reductions.decisionBoundary < 0.7 || report.reductions.mcpCalls < 0.7 ||
      report.reductions.agentBytes < 0.6)
    failures.push(`${prefix}:REDUCTION_GATE`);
  if (report.calls.repeatedStateReads !== 0 || report.calls.mcp > 4)
    failures.push(`${prefix}:CALL_BUDGET`);
  for (const id of [
    "m2-semantic-turn-surface",
    "m2-independent-outcome-channels",
    "m2-mission-flow-ownership",
    "m2-explicit-flow-handoffs",
    "m2-operation-ownership",
    "m2-call-reduction",
    "m2-no-repeated-state",
  ]) {
    if (!report.requiredChecks.some((check) => check.id === id && check.status === "passed"))
      failures.push(`${prefix}:CHECK:${id}`);
  }
  for (const phase of [
    "browser_startup",
    "document_observation",
    "native_resolution",
    "interaction_execution",
    "expected_effect_verification",
    "evidence_finalization",
    "artifact_retrieval",
  ]) {
    if (!report.timings[phase]?.count) failures.push(`${prefix}:TIMING:${phase}`);
  }
}

requirePassing("production_shaped", 1);
for (const target of [
  "vitract_preview",
  "automation_exercise",
  "demoblaze",
  "xyz_bank",
  "contact_list",
]) {
  for (const repetition of [1, 2, 3] as const) requirePassing(target, repetition);
}

if (failures.length) {
  process.stderr.write(`${[...new Set(failures)].join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Mission-first M2 release evidence verified (${latest.size} admitted reports; ${reports.length} retained attempts).\n`,
);

function requirePassing(target: string, repetition: 1 | 2 | 3) {
  const candidate = latest.get(`${target}:r${repetition}`);
  if (!candidate) failures.push(`M2_REPORT_REQUIRED:${target}:r${repetition}`);
  else if (candidate.report.verdict !== "pass") failures.push(`M2_REPORT_NOT_PASSING:${target}:r${repetition}`);
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
