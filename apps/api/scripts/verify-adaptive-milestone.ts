import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { assertCampaignPassed } from "./adaptive-campaign-evaluation.js";
import {
  assertRequiredMetricPhases,
  latestPassingCurrentRelease,
  matchesCampaignRelease,
} from "./adaptive-campaign-report-verification.js";
import { readCampaignReport } from "@scry/assurance";

try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const milestone = process.argv[2];
if (!["M0", "M1", "M2", "M3", "M4", "M5"].includes(milestone ?? "")) {
  throw new Error("ADAPTIVE_MILESTONE_REQUIRED");
}
const typedMilestone = milestone as "M0" | "M1" | "M2" | "M3" | "M4" | "M5";
const directory = fileURLToPath(
  new URL("../../../docs/runbooks/evidence/adaptive-campaigns/", import.meta.url),
);
const releaseIdentity = {
  releaseId: environment("SCRY_RELEASE_ID", "local-unreleased"),
  schemaFingerprint: environment("SCRY_SCHEMA_FINGERPRINT", "unverified-schema"),
  runtimeVersion: environment("SCRY_RUNTIME_VERSION", "local-runtime"),
  gitCommit: environment("SCRY_GIT_COMMIT", "uncommitted"),
};
const prefix = `${typedMilestone.toLowerCase()}-production_shaped-`;
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
if (!latest) throw new Error(`${typedMilestone}_PRODUCTION_SHAPED_REPORT_REQUIRED`);
const result = latest.result;
assertCampaignPassed(result);
if (typedMilestone === "M0" || typedMilestone === "M1") assertRequiredMetricPhases(result);
if (typedMilestone === "M1") {
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
      .filter((file) => file.startsWith(`${typedMilestone.toLowerCase()}-vitract_preview-`))
      .map((file) => readCampaignReport(path.join(directory, file))),
  );
  const vitract = vitractReports
    .filter((candidate) => matchesCampaignRelease(candidate, releaseIdentity))
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .at(-1);
  if (!vitract) throw new Error(`${typedMilestone}_CURRENT_RELEASE_VITRACT_REPORT_REQUIRED`);
  assertCampaignPassed(vitract);
}
process.stdout.write(`${typedMilestone} adaptive campaign evidence verified: ${latest.file}\n`);

function environment(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}
