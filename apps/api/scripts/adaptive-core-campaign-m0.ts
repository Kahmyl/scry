import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  recordCampaignFailure,
  retainResult,
  verifyMissionless,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";

const context = await createCampaignContext();
try {
  await checkProductionTopology(context);
  const deployed = await runDeployedCampaign({
    milestone: "M0",
    target: "production_shaped",
    correlationId: context.correlationId,
    metrics: context.metrics,
    fixtureOrigin: context.fixture.origin,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyMissionless(context);
  const retained = await retainResult(context, "M0");
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file })}\n`,
  );
  if (retained.result.verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error);
  const retained = await retainResult(context, "M0");
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}
