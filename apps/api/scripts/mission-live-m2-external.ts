import { randomUUID } from "node:crypto";

import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  recordCampaignFailure,
  requireLiveAcceptance,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";
import { missionLiveArguments } from "./mission-live-arguments.js";
import {
  m2Spec,
  m2Verdict,
  provisionM2Campaign,
  recordM2EfficiencyChecks,
  retainCanonicalM2Result,
  verifyM2Ownership,
  type M2Ownership,
} from "./mission-live-m2-support.js";
import {
  externalM2Intents,
  m2ExternalTargets,
  m2TargetRegistry,
  type M2ExternalTarget,
} from "./mission-live-m2-target-registry.js";

const [targetArgument, repetitionArgument] = missionLiveArguments(process.argv.slice(2));
const target = m2ExternalTargets.find((candidate) => candidate === targetArgument);
if (!target) throw new Error("M2_EXTERNAL_TARGET_REQUIRED");
const repetition = Number(repetitionArgument);
if (![1, 2, 3].includes(repetition)) throw new Error("M2_EXTERNAL_REPETITION_REQUIRED");
requireLiveAcceptance("M2", target);
const context = await createCampaignContext();
let ownership: M2Ownership | undefined;
try {
  await checkProductionTopology(context);
  const config = m2TargetRegistry[target];
  const prefix = `scry-m2-${context.campaignId.slice(0, 8)}`;
  const credentials =
    target === "contact_list"
      ? {
          email: { name: "M2 Contact List email", value: `${prefix}-${repetition}@example.test` },
          password: { name: "M2 Contact List password", value: `M2!${randomUUID()}` },
        }
      : undefined;
  const provisioned = await provisionM2Campaign(context, {
    target,
    mission: config.mission,
    origin: config.origin,
    flows: [...config.flows],
    ...(credentials ? { credentials } : {}),
    maxActions: 80,
    maxNavigations: 30,
    ...(target === "xyz_bank"
      ? {
          trustedScriptOrigins: [
            "https://ajax.googleapis.com",
            "https://cdnjs.cloudflare.com",
            "https://maxcdn.bootstrapcdn.com",
          ],
        }
      : {}),
  });
  ownership = provisioned.ownership;
  const turns = externalM2Intents({
    target,
    ownership,
    credentialIds: provisioned.credentialIds,
    campaignPrefix: prefix,
  });
  const deployed = await runDeployedCampaign({
    milestone: "M2",
    target,
    correlationId: context.correlationId,
    metrics: context.metrics,
    spec: m2Spec({
      context,
      ownership,
      firstFlow: config.flows[0]!.key,
      objective: config.mission,
      allowedOrigins: [config.origin],
      turns,
    }),
    forbiddenValues: context.forbiddenValues,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyM2Ownership(context, ownership);
  recordM2EfficiencyChecks(context, Object.keys(ownership.flows).length);
  const verdict = m2Verdict(context);
  const report = await retainCanonicalM2Result(context, {
    target,
    repetition: repetition as 1 | 2 | 3,
    ownership,
    verdict,
    cleanupRequired: true,
    cleanupRefs: [...config.cleanupRefs],
  });
  process.stdout.write(`${JSON.stringify({ target, repetition, verdict, report })}\n`);
  if (verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error, `m2-${target}`);
  if (ownership) {
    const report = await retainCanonicalM2Result(context, {
      target,
      repetition: repetition as 1 | 2 | 3,
      ownership,
      verdict: "fail",
      cleanupRequired: true,
    });
    process.stdout.write(
      `${JSON.stringify({ target, repetition, verdict: "fail", reasonCode: safeCode(error), report })}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ target, repetition, verdict: "blocked", reasonCode: safeCode(error) })}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : "M2_EXTERNAL_CAMPAIGN_FAILED";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 160) : "M2_EXTERNAL_CAMPAIGN_FAILED";
}

void (null as M2ExternalTarget | null);
