import { describe, expect, it } from "vitest";

import { projectMissionAgentSessionReplay } from "../src/missions/mission.service.js";

const missionId = "11111111-1111-4111-8111-111111111111";
const agentSessionId = "22222222-2222-4222-8222-222222222222";

describe("Mission agent-session replay projection", () => {
  it("keeps an active replay as existing usable authority", () => {
    expect(
      projectMissionAgentSessionReplay(missionId, {
        id: agentSessionId,
        status: "active",
      }),
    ).toMatchObject({
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
  });

  it("marks a completed replay as historical authority requiring a fresh key", () => {
    expect(
      projectMissionAgentSessionReplay(missionId, {
        id: agentSessionId,
        status: "completed",
      }),
    ).toMatchObject({
      status: "completed",
      replayed: true,
      replay: {
        owner: { missionId, agentSessionId },
        sessionTerminal: true,
        requiresFreshIdempotencyKey: true,
        safeActions: ["get_mission", "resume_mission"],
      },
    });
  });

  it("marks failed and interrupted replay authority terminal", () => {
    for (const status of ["failed", "interrupted"]) {
      expect(
        projectMissionAgentSessionReplay(missionId, {
          id: agentSessionId,
          status,
        }).replay,
      ).toMatchObject({
        sessionTerminal: true,
        requiresFreshIdempotencyKey: true,
      });
    }
  });
});
