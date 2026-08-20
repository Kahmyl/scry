import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  recordCampaignFailure,
  requireLiveAcceptance,
  retainCanonicalM1Result,
  retainResult,
  verifyMissionOwned,
  generatedExternalCampaignSpec,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";
import { missionLiveArguments } from "./mission-live-arguments.js";
import { m1ExternalTargetRegistry } from "./mission-live-m1-target-registry.js";

const targets = ["orangehrm", "expand_testing", "the_internet", "xyz_bank"] as const;
const [targetArgument, repetitionArgument] = missionLiveArguments(process.argv.slice(2));
const target = targets.find((candidate) => candidate === targetArgument);
if (!target) throw new Error("M1_EXTERNAL_TARGET_REQUIRED");
const repetition = Number(repetitionArgument);
if (![1, 2, 3].includes(repetition)) throw new Error("M1_EXTERNAL_REPETITION_REQUIRED");
requireLiveAcceptance("M1", target);
const context = await createCampaignContext();
try {
  await checkProductionTopology(context);
  const generated = await generatedExternalCampaignSpec(context, target);
  const deployed = await runDeployedCampaign({
    milestone: "M1",
    target,
    correlationId: context.correlationId,
    metrics: context.metrics,
    spec: generated.spec,
    forbiddenValues: generated.forbiddenValues,
    resolutionThresholds: m1ExternalTargetRegistry[target].resolutionThresholds,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyMissionOwned(context);
  const retained = await retainResult(context, "M1");
  const canonicalReport = await retainCanonicalM1Result(context, {
    target,
    repetition: repetition as 1 | 2 | 3,
    verdict: retained.result.verdict,
    evidenceRefs: [retained.file],
    cleanupRequired: true,
  });
  process.stdout.write(
    `${JSON.stringify({ target, repetition, verdict: retained.result.verdict, canonicalReport })}\n`,
  );
  if (retained.result.verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error, `m1-${target}`);
  const retained = await retainResult(context, "M1", [], target);
  const canonicalReport = await retainCanonicalM1Result(context, {
    target,
    repetition: repetition as 1 | 2 | 3,
    verdict: "blocked",
    evidenceRefs: [retained.file],
    cleanupRequired: Boolean(context.campaignProjectId),
  });
  process.stdout.write(
    `${JSON.stringify({ target, repetition, verdict: "blocked", reasonCode: safeCode(error), canonicalReport })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}

function safeCode(error: unknown) {
  const message = error instanceof Error ? error.message : "M1_EXTERNAL_CAMPAIGN_FAILED";
  return /^[A-Z0-9_:-]+$/.test(message) ? message.slice(0, 160) : "M1_EXTERNAL_CAMPAIGN_FAILED";
}
