import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  generatedVitractCampaignSpec,
  recordCampaignFailure,
  retainResult,
  verifyMissionless,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";

const milestone = process.argv[2];
if (milestone !== "M0" && milestone !== "M1") throw new Error("ADAPTIVE_MILESTONE_REQUIRED");

const context = await createCampaignContext();
try {
  await checkProductionTopology(context);
  const vitract = await generatedVitractCampaignSpec(context, milestone);
  const deployed = await runDeployedCampaign({
    milestone,
    target: "vitract_preview",
    correlationId: context.correlationId,
    metrics: context.metrics,
    spec: vitract.spec,
    forbiddenValues: vitract.forbiddenValues,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyMissionless(context);
  const retained = await retainResult(context, milestone, [], "vitract_preview");
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file })}\n`,
  );
  if (retained.result.verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error);
  const retained = await retainResult(context, milestone, [], "vitract_preview");
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}
