import { createHash } from "node:crypto";

import { z } from "zod";

export const uuid = z.string().uuid();

export const localFactualRead = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const idempotentDurableWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function stableKey(scope: string, value: unknown) {
  return `mcp-${scope}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function toolResult(data: Record<string, unknown>, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ message, ...data }, null, 2) }],
    structuredContent: { message, ...data },
  };
}
