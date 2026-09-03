import { startedAgentSessionSchema, type StartedAgentSession } from "@scry/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  flowRevisionContentSchema,
  currentPlanSchema,
  executionPolicySchema,
  requestCalibrationSchema,
  flowPurposeSchema,
  flowVisibilitySchema,
  runRoleSchema,
  missionResumePointerSchema,
  executionBindingSchema,
  authorizationKindSchema,
  protectedRecoveryCommandSchema,
  veilPreferenceUpdateSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import {
  missionContext,
  objectiveContext,
  readOnly,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

export function registerResumeMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "resume_mission",
    {
      title: "Resume Mission",
      description:
        "Resume the same existing Mission and Objective only after the current user request has explicitly chosen that Mission. continuationAuthority.selection must use the exact schema literal continue_existing_mission; never substitute a Mission title, ID, or paraphrase. or the current interaction already established continuation of it. Similarity alone is not continuation authority. continuationAuthority is an explicit attestation of that user choice: never construct it merely because a Mission looks related, is the only candidate, or appears resumable. A non-replayed request creates a new active Mission agent session; use the returned agentSessionId for subsequent writes. A replay may instead return historical or existing authority: inspect session.replay.sessionTerminal and session.replay.requiresFreshIdempotencyKey before continuing. For awaiting_user, read externalInput.lifecycle and fulfillmentPaths and keep the Mission non-terminal while a prerequisite remains obtainable.",
      annotations: writes,
      inputSchema: {
        missionId: uuid,
        instructionSnapshot: z.string().trim().min(1).max(20_000),
        connectionId: z.string().trim().min(1).max(500).optional(),
        continuationAuthority: z
          .object({
            confirmedUserAuthorized: z.literal(true),
            selection: z.literal("continue_existing_mission"),
            source: z.enum(["current_request_explicit", "followup_explicit_choice"]),
          })
          .strict(),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
    },
    async ({ missionId, idempotencyKey, ...body }) => {
      const provenance = client.missionProvenance();
      const session = await client.post(`/missions/${missionId}/agent-sessions`, {
        ...body,
        ...provenance,
        idempotencyKey:
          idempotencyKey ?? stableKey("mission-session", { missionId, ...body, ...provenance }),
      });
      const parsedSession = startedAgentSessionSchema.parse(session);
      const mission = await client.get(`/missions/${missionId}`);
      return result({ session: parsedSession, mission }, resumeMissionResultMessage(parsedSession));
    },
  );
}

export function resumeMissionResultMessage(session: StartedAgentSession) {
  if (!session.replayed) {
    return "Mission resumed with a fresh active agent session. Follow its persisted resume pointer.";
  }

  if (session.replay?.sessionTerminal) {
    return "Resume request replayed a terminal agent session; no fresh agent authority was created. If the Mission remains resumable, call resume_mission again with a fresh idempotencyKey.";
  }

  return "Resume request replayed the existing active agent session; no additional agent session was created. Continue using the returned agentSessionId.";
}
