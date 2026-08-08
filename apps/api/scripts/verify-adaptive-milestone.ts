import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  assertCampaignPassed,
  assertRequiredMetricPhases,
  latestPassingCurrentRelease,
  matchesCampaignRelease,
  readCampaignReport,
} from "@scry/campaigns";

const milestone = process.argv[2];
if (milestone !== "M0" && milestone !== "M1") throw new Error("ADAPTIVE_MILESTONE_REQUIRED");
const directory = path.resolve("docs/runbooks/evidence/adaptive-campaigns");
const releaseIdentity = {
  releaseId: requiredEnvironment("SCRY_RELEASE_ID"),
  schemaFingerprint: requiredEnvironment("SCRY_SCHEMA_FINGERPRINT"),
  runtimeVersion: requiredEnvironment("SCRY_RUNTIME_VERSION"),
  gitCommit: requiredEnvironment("SCRY_GIT_COMMIT"),
};
const prefix = `${milestone.toLowerCase()}-production_shaped-`;
const reports = (await readdir(directory).catch(() => []))
  .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
  .sort();
const parsedReports = await Promise.all(
  reports.map(async (file) => ({
    file,
    result: await readCampaignReport(path.join(directory, file)),
  })),
);
const latest = parsedReports
  .filter(({ result }) => matchesCampaignRelease(result, releaseIdentity))
  .sort((left, right) => left.result.completedAt.localeCompare(right.result.completedAt))
  .at(-1);
if (!latest) throw new Error(`${milestone}_PRODUCTION_SHAPED_REPORT_REQUIRED`);
const result = latest.result;
assertCampaignPassed(result);
assertRequiredMetricPhases(result);
if (milestone === "M1") {
  const m0Reports = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.startsWith("m0-production_shaped-") && file.endsWith(".json"))
      .map((file) => readCampaignReport(path.join(directory, file))),
  );
  const baseline = latestPassingCurrentRelease(m0Reports, releaseIdentity);
  if (!baseline || !result.artifactRefs.includes(baseline.campaignId)) {
    throw new Error("M1_CURRENT_RELEASE_BASELINE_BINDING_REQUIRED");
  }
}
if (process.env.SCRY_REQUIRE_VITRACT_REPORT === "true") {
  const vitractReports = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.startsWith(`${milestone.toLowerCase()}-vitract_preview-`))
      .map((file) => readCampaignReport(path.join(directory, file))),
  );
  const vitract = vitractReports
    .filter((candidate) => matchesCampaignRelease(candidate, releaseIdentity))
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .at(-1);
  if (!vitract) throw new Error(`${milestone}_CURRENT_RELEASE_VITRACT_REPORT_REQUIRED`);
  assertCampaignPassed(vitract);
}
process.stdout.write(`${milestone} adaptive campaign evidence verified: ${latest.file}\n`);

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
