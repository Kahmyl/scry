import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  coreM2Flows,
  coreM2Intents,
  externalM2Intents,
  m2ExternalTargets,
  m2TargetRegistry,
  vitractM2Flows,
  vitractM2Intents,
} from "../scripts/mission-live-m2-target-registry.js";
import type { M2FlowDefinition, M2Ownership } from "../scripts/mission-live-m2-support.js";

describe("M2 live target registry", () => {
  it("builds every core and live journey entirely from admitted semantic intents", () => {
    const coreOwnership = ownership(coreM2Flows());
    const vitractOwnership = ownership(vitractM2Flows());
    const journeys = [
      coreM2Intents({
        origin: "http://fixture.test",
        ownership: coreOwnership,
        emailCredentialId: randomUUID(),
        passwordCredentialId: randomUUID(),
      }),
      vitractM2Intents({
        ownership: vitractOwnership,
        emailCredentialId: randomUUID(),
        passwordCredentialId: randomUUID(),
      }),
      ...m2ExternalTargets.map((target) => externalM2Intents({
        target,
        ownership: ownership([...m2TargetRegistry[target].flows]),
        credentialIds: { email: randomUUID(), password: randomUUID() },
        campaignPrefix: "scry-m2-registry",
      })),
    ];

    for (const turns of journeys) {
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.length).toBeLessThanOrEqual(2);
      expect(new Set(turns.flat().map((intent) => intent.flowDraftId)).size).toBeGreaterThanOrEqual(3);
      for (const turn of turns) {
        expect(turn.length).toBeGreaterThan(0);
        expect(turn.length).toBeLessThanOrEqual(20);
        expect(turn.every((intent) => !("operation" in intent))).toBe(true);
      }
    }
  });
});

function ownership(flows: M2FlowDefinition[]): M2Ownership {
  return {
    projectId: randomUUID(),
    environmentId: randomUUID(),
    missionId: randomUUID(),
    agentSessionId: randomUUID(),
    flows: Object.fromEntries(flows.map((flow) => [flow.key, {
      objectiveId: randomUUID(),
      flowDraftId: randomUUID(),
      authorizationId: randomUUID(),
    }])),
  };
}
