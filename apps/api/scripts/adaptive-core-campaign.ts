import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  CampaignMetricsCollector,
  evaluateRequiredChecks,
  milestoneCampaignResultSchema,
  retainCampaignReport,
  type AdaptiveMilestone,
  type CampaignCheck,
} from "@scry/campaigns";

import { milestoneCommands, runMilestoneCommands } from "./adaptive-milestone-checks.js";

loadEnvFileIfPresent();
const milestone = parseMilestone(process.argv[2]);
const campaignId = randomUUID();
const correlationId = randomUUID();
const startedAt = new Date().toISOString();
const metrics = new CampaignMetricsCollector(correlationId);
let requiredChecks: CampaignCheck[] = [];
let artifactRefs: string[] = [];

try {
  const executed = await runMilestoneCommands({ milestone, correlationId, metrics });
  requiredChecks = executed.checks;
  artifactRefs = executed.artifactRefs;
} catch (error) {
  requiredChecks.push({
    id: `${milestone.toLowerCase()}-campaign-runner`,
    description: "The milestone campaign runner completes its configured checks",
    status: "failed",
    reasonCode: safeCode(error),
  });
}

const result = milestoneCampaignResultSchema.parse({
  schemaVersion: 1,
  campaignId,
  correlationId,
  milestone,
  target: "production_shaped",
  releaseId: environment("SCRY_RELEASE_ID", "local-unreleased"),
  schemaFingerprint: environment("SCRY_SCHEMA_FINGERPRINT", "unverified-schema"),
  runtimeVersion: environment("SCRY_RUNTIME_VERSION", "local-runtime"),
  gitCommit: environment("SCRY_GIT_COMMIT", "uncommitted"),
  startedAt,
  completedAt: new Date().toISOString(),
  requiredChecks,
  observationalChecks: [],
  futureScope: futureScope(milestone),
  metrics: metrics.snapshot(),
  artifactRefs,
  verdict: evaluateRequiredChecks(requiredChecks),
});
const directory = fileURLToPath(
  new URL("../../../docs/runbooks/evidence/adaptive-campaigns/", import.meta.url),
);
const file = await retainCampaignReport({ directory, result });
process.stdout.write(`${JSON.stringify({ verdict: result.verdict, report: file })}\n`);
if (result.verdict !== "pass") process.exitCode = 1;

export function parseMilestone(value: string | undefined): AdaptiveMilestone {
  if (value === "M2" || value === "M3" || value === "M4" || value === "M5") return value;
  throw new Error("ADAPTIVE_CORE_MILESTONE_M2_M5_REQUIRED");
}

function futureScope(milestone: AdaptiveMilestone): CampaignCheck[] {
  if (milestone === "M5") return [];
  const next = `M${Number(milestone.slice(1)) + 1}`;
  return [
    {
      id: `${milestone.toLowerCase()}-later-scope`,
      description: `${next} and later acceptance remain outside this milestone verdict`,
      status: "awaiting_codex_verification",
      reasonCode: "FUTURE_MILESTONE_SCOPE",
    },
  ];
}

function environment(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}

function safeCode(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)) return error.message.slice(0, 160);
  return "CAMPAIGN_RUNNER_FAILED";
}

function loadEnvFileIfPresent() {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export { milestoneCommands };
