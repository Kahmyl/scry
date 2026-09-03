import { describe, expect, it } from "vitest";
import { startedAgentSessionSchema } from "@scry/contracts";

import { resumeMissionResultMessage } from "../src/tools/missions/resume-mission.tool.js";

const missionId = "11111111-1111-4111-8111-111111111111";
const agentSessionId = "22222222-2222-4222-8222-222222222222";

describe("resume_mission replay actionability", () => {
  it("says terminal replay created no fresh authority", () => {
    const session = startedAgentSessionSchema.parse({
      missionId,
      agentSessionId,
      status: "completed",
      replayed: true,
      replay: {
        idempotencyScope: "mission_agent_session",
        owner: { missionId, agentSessionId },
        sessionTerminal: true,
        requiresFreshIdempotencyKey: true,
        safeActions: ["get_mission", "resume_mission"],
      },
    });

    const message = resumeMissionResultMessage(session);

    expect(message).toContain("terminal agent session");
    expect(message).toContain("no fresh agent authority");
    expect(message).toContain("fresh idempotencyKey");
  });

  it("distinguishes replay of existing active authority", () => {
    const session = startedAgentSessionSchema.parse({
      missionId,
      agentSessionId,
      status: "active",
      replayed: true,
      replay: {
        idempotencyScope: "mission_agent_session",
        owner: { missionId, agentSessionId },
        sessionTerminal: false,
        requiresFreshIdempotencyKey: false,
        safeActions: ["get_mission"],
      },
    });

    expect(resumeMissionResultMessage(session)).toContain("existing active agent session");
  });

  it("distinguishes genuinely fresh authority", () => {
    const session = startedAgentSessionSchema.parse({
      missionId,
      agentSessionId,
      status: "active",
      replayed: false,
    });

    expect(resumeMissionResultMessage(session)).toContain("fresh active agent session");
  });
});
