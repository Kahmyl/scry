import { describe, expect, it } from "vitest";

import { startedAgentSessionSchema } from "../src/mission.js";

const missionId = "11111111-1111-4111-8111-111111111111";
const agentSessionId = "22222222-2222-4222-8222-222222222222";

describe("Mission agent-session replay facts", () => {
  it("marks an active replay as reusable without a fresh key", () => {
    expect(
      startedAgentSessionSchema.parse({
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
      }),
    ).toMatchObject({
      replayed: true,
      replay: {
        sessionTerminal: false,
        requiresFreshIdempotencyKey: false,
      },
    });
  });

  it("marks a completed replay as terminal and requiring a fresh key", () => {
    expect(
      startedAgentSessionSchema.parse({
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
      }),
    ).toMatchObject({
      replayed: true,
      replay: {
        sessionTerminal: true,
        requiresFreshIdempotencyKey: true,
      },
    });
  });

  it("rejects replay facts whose terminality contradicts session state", () => {
    expect(() =>
      startedAgentSessionSchema.parse({
        missionId,
        agentSessionId,
        status: "failed",
        replayed: true,
        replay: {
          idempotencyScope: "mission_agent_session",
          owner: { missionId, agentSessionId },
          sessionTerminal: false,
          requiresFreshIdempotencyKey: false,
          safeActions: ["get_mission"],
        },
      }),
    ).toThrow();
  });

  it("requires replay provenance whenever replayed is true", () => {
    expect(() =>
      startedAgentSessionSchema.parse({
        missionId,
        agentSessionId,
        status: "completed",
        replayed: true,
      }),
    ).toThrow();
  });
});
