import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { latestPassingCurrentRelease, readCampaignReport } from "@scry/campaigns";

import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  generatedCoreCampaignSpec,
  recordCampaignFailure,
  retainResult,
  verifyMissionless,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";

const context = await createCampaignContext();
let baselineId: string | undefined;
try {
  await checkProductionTopology(context);
  const baseline = await latestM0Baseline();
  baselineId = baseline.campaignId;
  const spec = await generatedCoreCampaignSpec(context, "M1");
  const deployed = await runDeployedCampaign({
    milestone: "M1",
    target: "production_shaped",
    correlationId: context.correlationId,
    metrics: context.metrics,
    fixtureOrigin: context.fixture.origin,
    spec,
    forbiddenValues: context.forbiddenValues,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyMissionless(context);

  const metrics = context.metrics.snapshot();
  const comparisons = {
    decisionReduction: reduction(
      baseline.metrics.agentDecisionBoundaries,
      metrics.agentDecisionBoundaries,
    ),
    mcpReduction: reduction(baseline.metrics.mcpRequests, metrics.mcpRequests),
    byteReduction: reduction(baseline.metrics.bytesReturnedToAgent, metrics.bytesReturnedToAgent),
  };
  const rawDecisionReduction =
    baseline.metrics.agentDecisionBoundaries - metrics.agentDecisionBoundaries;
  const rawMcpReduction = baseline.metrics.mcpRequests - metrics.mcpRequests;
  context.requiredChecks.push(
    gate(
      "latency-boundaries",
      "Agent decision boundaries fall by at least 70 percent and five raw calls",
      comparisons.decisionReduction >= 0.7 && rawDecisionReduction >= 5,
      "M1_DECISION_BOUNDARY_BUDGET_MISSED",
    ),
    gate(
      "latency-mcp",
      "MCP authoring calls fall by at least 70 percent and five raw calls",
      comparisons.mcpReduction >= 0.7 && rawMcpReduction >= 5,
      "M1_MCP_CALL_BUDGET_MISSED",
    ),
    gate(
      "latency-bytes",
      "Unchanged agent-facing bytes are reduced by at least 60 percent",
      comparisons.byteReduction >= 0.6,
      "M1_AGENT_BYTE_BUDGET_MISSED",
    ),
    gate(
      "latency-absolute",
      "The grouped journey uses at most four decision boundaries and one MCP call",
      metrics.agentDecisionBoundaries <= 4 && metrics.mcpRequests === 1,
      "M1_ABSOLUTE_ROUND_TRIP_BUDGET_MISSED",
    ),
    gate(
      "latency-no-plan-rewrites",
      "The grouped journey performs no unchanged-state reads or plan rewrites",
      metrics.unchangedStateReads === 0,
      "M1_UNCHANGED_STATE_READS_REMAIN",
    ),
    gate(
      "latency-praxis-regression",
      "Median Praxis dispatch time increases by no more than ten percent",
      withinPraxisBudget(baseline, metrics),
      "M1_PRAXIS_MEDIAN_REGRESSION",
    ),
  );

  const retained = await retainResult(context, "M1", [baseline.campaignId]);
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file, comparison: comparisons })}\n`,
  );
  if (retained.result.verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error);
  const retained = await retainResult(context, "M1", baselineId ? [baselineId] : []);
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}

async function latestM0Baseline() {
  const directory = fileURLToPath(
    new URL("../../../docs/runbooks/evidence/adaptive-campaigns/", import.meta.url),
  );
  const release = releaseIdentity();
  const reports = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.startsWith("m0-production_shaped-") && file.endsWith(".json"))
      .map((file) => readCampaignReport(path.join(directory, file))),
  );
  const report = latestPassingCurrentRelease(reports, release);
  if (!report) throw new Error("CURRENT_RELEASE_M0_BASELINE_REQUIRED");
  return report;
}

function releaseIdentity() {
  return {
    releaseId: requiredEnvironment("SCRY_RELEASE_ID"),
    schemaFingerprint: requiredEnvironment("SCRY_SCHEMA_FINGERPRINT"),
    runtimeVersion: requiredEnvironment("SCRY_RUNTIME_VERSION"),
    gitCommit: requiredEnvironment("SCRY_GIT_COMMIT"),
  };
}

function gate(id: string, description: string, passed: boolean, reasonCode: string) {
  return {
    id,
    description,
    status: passed ? ("passed" as const) : ("failed" as const),
    ...(!passed ? { reasonCode } : {}),
  };
}

function reduction(baseline: number, current: number) {
  if (baseline <= 0) return current === 0 ? 1 : 0;
  return (baseline - current) / baseline;
}

function withinPraxisBudget(
  baseline: Awaited<ReturnType<typeof latestM0Baseline>>,
  current: ReturnType<typeof context.metrics.snapshot>,
) {
  const before = baseline.metrics.phases.interaction_execution?.p50Ms;
  const after = current.phases.interaction_execution?.p50Ms;
  return before !== undefined && after !== undefined && after <= before * 1.1;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
