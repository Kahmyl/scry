import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
  recordCampaignFailure,
} from "./adaptive-campaign-support.js";
import { runDeployedCampaign } from "./deployed-adaptive-campaign.js";
import {
  m2Spec,
  m2Verdict,
  provisionM2Campaign,
  recordM2EfficiencyChecks,
  retainCanonicalM2Result,
  verifyM2Ownership,
  type M2Ownership,
} from "./mission-live-m2-support.js";
import { coreM2Flows, coreM2Intents } from "./mission-live-m2-target-registry.js";

const context = await createCampaignContext();
let ownership: M2Ownership | undefined;
try {
  await checkProductionTopology(context);
  const provisioned = await provisionM2Campaign(context, {
    target: "production_shaped",
    mission: "M2 production-shaped multi-Flow fixture",
    origin: context.fixture.origin,
    flows: coreM2Flows(),
    credentials: {
      email: { name: "M2 fixture email", value: `m2-${context.campaignId}@example.test` },
      password: { name: "M2 fixture password", value: context.secretValue },
    },
  });
  ownership = provisioned.ownership;
  const turns = coreM2Intents({
    origin: context.fixture.origin,
    ownership,
    emailCredentialId: provisioned.credentialIds.email!,
    passwordCredentialId: provisioned.credentialIds.password!,
  });
  const deployed = await runDeployedCampaign({
    milestone: "M2",
    target: "production_shaped",
    correlationId: context.correlationId,
    metrics: context.metrics,
    fixtureOrigin: context.fixture.origin,
    spec: m2Spec({
      context,
      ownership,
      firstFlow: "authenticate",
      objective: "Complete the production-shaped multi-Flow fixture journey",
      allowedOrigins: [context.fixture.origin],
      turns,
    }),
    forbiddenValues: context.forbiddenValues,
  });
  context.requiredChecks.push(...deployed.requiredChecks);
  await verifyM2Ownership(context, ownership);
  recordM2EfficiencyChecks(context, Object.keys(ownership.flows).length);
  const verdict = m2Verdict(context);
  const report = await retainCanonicalM2Result(context, {
    target: "production_shaped",
    repetition: 1,
    ownership,
    verdict,
  });
  process.stdout.write(`${JSON.stringify({ verdict, report })}\n`);
  if (verdict !== "pass") process.exitCode = 1;
} catch (error) {
  recordCampaignFailure(context, error, "m2-production-shaped");
  if (ownership) {
    const report = await retainCanonicalM2Result(context, {
      target: "production_shaped",
      repetition: 1,
      ownership,
      verdict: "fail",
    });
    process.stdout.write(
      `${JSON.stringify({ verdict: "fail", report, reasonCode: safeCode(error) })}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ verdict: "blocked", reasonCode: safeCode(error) })}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  await closeCampaignContext(context);
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : "M2_PRODUCTION_SHAPED_FAILED";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 160) : "M2_PRODUCTION_SHAPED_FAILED";
}
