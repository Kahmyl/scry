import { createHash } from "node:crypto";

import { z } from "zod";

export const uuid = z.string().uuid();
export const localFactualRead = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
export const externalFactualRead = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;
export const idempotentDurableWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const nonDestructiveScryWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export const externalOpenWorldOperation = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
export const idempotentExternalOpenWorldOperation = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
export const potentiallyDestructiveExternalOperation = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
export const idempotentPotentiallyDestructiveExternalOperation = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Compatibility names for local tools not requiring a more conservative profile. */
export const readOnly = localFactualRead;
export const writes = nonDestructiveScryWrite;
export const missionContext = { missionId: uuid, agentSessionId: uuid } as const;
export const objectiveContext = { ...missionContext, objectiveId: uuid } as const;

export function stableKey(scope: string, value: unknown) {
  return `mcp-${scope}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function toolResult(data: Record<string, unknown>, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ message, ...data }, null, 2) }],
    structuredContent: { message, ...data },
  };
}

export function agentSessionFinalization(
  agentSessionId: string,
  recommendedStatus: "completed" | "interrupted" | "failed",
) {
  return {
    agentSessionFinalization: {
      required: true as const,
      tool: "end_agent_session" as const,
      agentSessionId,
      recommendedStatus,
    },
  };
}
