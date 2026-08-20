import { closeCampaignContext, createCampaignContext } from "./adaptive-campaign-support.js";
import { provisionM2Campaign } from "./mission-live-m2-support.js";

const context = await createCampaignContext();
const provisioned = await provisionM2Campaign(context, {
  target: "protected-qualification",
  mission: "Controlled protected-output qualification",
  origin: context.fixture.origin,
  ...(process.env.SCRY_CAMPAIGN_WORKSPACE_ID
    ? { workspaceId: process.env.SCRY_CAMPAIGN_WORKSPACE_ID }
    : {}),
  maxActions: 12,
  maxDurationMs: 60_000,
  maxNavigations: 4,
  flows: [
    flow("readonlyInput", "readonly input acquisition"),
    flow("textOutput", "text output acquisition"),
    flow("interruptedAcquisition", "interrupted acquisition"),
  ],
});

process.stdout.write(
  `${JSON.stringify({
    ready: true,
    projectId: provisioned.ownership.projectId,
    environmentId: provisioned.ownership.environmentId,
    missionId: provisioned.ownership.missionId,
    agentSessionId: provisioned.ownership.agentSessionId,
    origin: context.fixture.origin,
    flows: provisioned.ownership.flows,
  })}\n`,
);

const stopped = new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await stopped;
process.stdout.write(
  `${JSON.stringify({
    stopped: true,
    dispatches: context.fixture.snapshot().protectedDispatches,
  })}\n`,
);
await closeCampaignContext(context);

function flow(key: string, label: string) {
  return {
    key,
    objective: `Qualify ${label}`,
    flow: `Controlled ${label}`,
    purpose: "acceptance" as const,
    authorizeMutation: true,
    authorizationKind: "protected_mutation" as const,
  };
}
