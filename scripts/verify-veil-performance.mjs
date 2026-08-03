import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const profile = JSON.parse(
  await readFile(
    new URL("../docs/architecture/veil-performance-profile.json", import.meta.url),
    "utf8",
  ),
);
const expected = {
  cachedDecisionP50Ms: 1,
  cachedDecisionP95Ms: 3,
  structuralDecisionP95Ms: 15,
  leaseValidationP95Ms: 1,
  collectorSuspensionP95Ms: 100,
  cancellationPropagationMs: 250,
  retainedMemoryGrowthPercent: 30,
};
const failures = [];
for (const [key, value] of Object.entries(expected))
  if (profile.limits?.[key] !== value) failures.push(`${key} must equal ${value}`);
if (profile.schemaVersion !== 1) failures.push("schemaVersion must equal 1");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
const run = spawnSync("pnpm", ["--filter", "@scry/executor", "campaign:veil:performance"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);
const start = run.stdout.indexOf("{");
if (start < 0) throw new Error("Veil performance campaign emitted no JSON report");
const report = JSON.parse(run.stdout.slice(start));
if (report.counts?.failed !== 0 || report.qualification !== "PERFORMANCE_COMPONENT_PASS")
  throw new Error("Veil performance campaign did not qualify");
const measuredFailures = [];
if (report.metrics.repeatedDecisionP50Ms >= profile.limits.cachedDecisionP50Ms)
  measuredFailures.push("repeated decision p50 exceeds cached-decision threshold");
if (report.metrics.repeatedDecisionP95Ms >= profile.limits.cachedDecisionP95Ms)
  measuredFailures.push("repeated decision p95 exceeds cached-decision threshold");
if (report.metrics.structuralDecisionP95Ms >= profile.limits.structuralDecisionP95Ms)
  measuredFailures.push("structural decision p95 exceeds threshold");
if (report.metrics.leaseValidationP95Ms >= profile.limits.leaseValidationP95Ms)
  measuredFailures.push("lease validation p95 exceeds threshold");
if (report.metrics.collectorSuspensionP95Ms >= profile.limits.collectorSuspensionP95Ms)
  measuredFailures.push("collector suspension p95 exceeds threshold");
if (report.metrics.cancellationPropagationP95Ms >= profile.limits.cancellationPropagationMs)
  measuredFailures.push("cancellation propagation p95 exceeds threshold");
if (report.coverage?.cacheProof !== true)
  measuredFailures.push(
    "cached-decision threshold is not qualified because the authority exposes no observable cache proof",
  );
if (measuredFailures.length) {
  process.stderr.write(`${measuredFailures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Veil performance profile and executable measurements verified for ${profile.referenceEnvironment}.\n`,
);
