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
  loadVitractCredentialValues,
  m2Spec,
  m2Verdict,
  provisionM2Campaign,
  recordM2EfficiencyChecks,
  retainCanonicalM2Result,
  verifyM2Ownership,
  type M2Ownership,
} from "./mission-live-m2-support.js";
import {
  vitractM2Flows,
  vitractM2Intents,
  vitractRecoveryApplicationName,
} from "./mission-live-m2-target-registry.js";

const [, repetitionArgument] = missionLiveArguments(process.argv.slice(2));
const repetition = Number(repetitionArgument);
if (![1, 2, 3].includes(repetition)) throw new Error("M2_VITRACT_REPETITION_REQUIRED");
requireLiveAcceptance("M2", "vitract_preview");
const context = await createCampaignContext();
let ownership: M2Ownership | undefined;
try {
  await checkProductionTopology(context);
  const credentials = await loadVitractCredentialValues();
  const provisioned = await provisionM2Campaign(context, {
    target: "vitract_preview",
    mission: "M2 Vitract Test application credential-boundary recovery",
    origin: "https://preview.vitract.com",
    allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
    flows: vitractM2Flows(),
    credentials,
    maxActions: 30,
    maxNavigations: 8,
    trustedScriptOrigins: ["https://js.stripe.com", "https://maps.googleapis.com"],
  });
  ownership = provisioned.ownership;
  const applicationName = vitractRecoveryApplicationName(ownership);
  const turns = vitractM2Intents({
    ownership,
    emailCredentialId: provisioned.credentialIds.email!,
    passwordCredentialId: provisioned.credentialIds.password!,
  });
  const deployed = await runDeployedCampaign({
    milestone: "M2",
    target: "vitract_preview",
    correlationId: context.correlationId,
    metrics: context.metrics,
    spec: m2Spec({
      context,
      ownership,
      firstFlow: "authenticate",
      objective: `Create Test application ${applicationName} and open its Add credential dialog without generating a credential`,
      allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
      turns,
    }),
    forbiddenValues: context.forbiddenValues,
  });
  context.requiredChecks.push(...deployed.requiredChecks, {
    id: "m2-vitract-resource-scope",
    description:
      "The Vitract journey creates one uniquely named Test application and contains no credential, order, notification, or charge creation intent",
    status: "passed",
  });
  await verifyM2Ownership(context, ownership);
  recordM2EfficiencyChecks(context, Object.keys(ownership.flows).length);
  const verdict = m2Verdict(context);
  const report = await retainCanonicalM2Result(context, {
    target: "vitract_preview",
    repetition: repetition as 1 | 2 | 3,
    ownership,
    verdict,
  });
  process.stdout.write(
    `${JSON.stringify({ target: "vitract_preview", repetition, verdict, report })}\n`,
  );
  if (verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error, "m2-vitract-preview");
  if (ownership) {
    const report = await retainCanonicalM2Result(context, {
      target: "vitract_preview",
      repetition: repetition as 1 | 2 | 3,
      ownership,
      verdict: "fail",
    });
    process.stdout.write(
      `${JSON.stringify({ target: "vitract_preview", repetition, verdict: "fail", reasonCode: safeCode(error), report })}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ target: "vitract_preview", repetition, verdict: "blocked", reasonCode: safeCode(error) })}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : "M2_VITRACT_CAMPAIGN_FAILED";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 160) : "M2_VITRACT_CAMPAIGN_FAILED";
}
