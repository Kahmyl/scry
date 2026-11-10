import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserSequenceInputSchema } from "@scry/contracts";
import type { BrowserApiClient } from "./api-client.js";
import { toolAuthMetadata } from "./oauth-discovery.js";
import { uuid } from "./tool-registry.js";
import { nativeCommandResult } from "./native-browser-tools.js";

type Poll = (
  client: BrowserApiClient,
  id: string,
  ms: number,
) => Promise<Record<string, unknown> | undefined>;

export function registerBrowserSequence(server: McpServer, client: BrowserApiClient, poll: Poll) {
  server.registerTool(
    "browser_sequence",
    {
      description:
        "Submit one worker-owned plan of up to eight already-known native controls. Use current snapshot references, a stable planId and distinct actionIds. Clicks, key presses and submit end the plan. The worker binds observed control meaning, serializes the whole plan, preserves each receipt and stops on change, error, cancellation or uncertainty. Secrets use bound references only. Exact retry retrieves receipts and never repeats uncertain work. One final snapshot is returned; verify business state separately. Host approval applies to all proposed effects.",
      inputSchema: { browserSessionId: uuid, ...browserSequenceInputSchema.shape },
      _meta: toolAuthMetadata(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ browserSessionId, ...requested }) => {
      const plan = browserSequenceInputSchema.parse(requested);
      const submitted = await client.post<{ commandId: string; state: string }>(
        `/browser-sessions/${browserSessionId}/commands`,
        {
          command: { kind: "browser_tool", tool: "browser_sequence", args: plan },
          idempotencyKey: `sequence-v1:${plan.planId}`,
        },
      );
      const observed = await poll(client, submitted.commandId, 25_000);
      const final = observed ? await nativeCommandResult(client, observed) : undefined;
      const result = observed?.result as Record<string, unknown> | undefined;
      const complete =
        observed?.state === "completed" &&
        result?.execution === "completed" &&
        result?.observation === "available" &&
        final?.isError !== true;
      const structuredContent = {
        message: complete
          ? "Planned actions completed. Verify the resulting business state."
          : "Inspect this durable command before continuing. Pending or uncertain actions must not be replayed.",
        commandId: submitted.commandId,
        state: observed?.state ?? submitted.state,
        complete,
        ...(final ? { command: final.structuredContent.command } : {}),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(structuredContent) },
          ...(final?.content.filter((c) => c.type === "image") ?? []),
        ],
        structuredContent,
        isError: final?.isError ?? false,
      };
    },
  );
}
