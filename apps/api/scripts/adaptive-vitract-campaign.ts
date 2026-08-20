import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  generatedVitractCampaignSpec,
  recordCampaignFailure,
  retainResult,
  retainCanonicalM1Result,
  verifyMissionOwned,
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
  await verifyMissionOwned(context);
  const retained = await retainResult(context, milestone, [], "vitract_preview");
  const canonicalReport =
    milestone === "M1"
      ? await retainCanonicalM1Result(context, {
          target: "vitract_preview",
          repetition: Number(process.env.SCRY_CAMPAIGN_REPETITION) as 1 | 2 | 3,
          verdict: retained.result.verdict,
          evidenceRefs: [retained.file],
          cleanupRequired: true,
        })
      : undefined;
  process.stdout.write(
    `${JSON.stringify({ verdict: retained.result.verdict, report: retained.file, canonicalReport })}\n`,
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
