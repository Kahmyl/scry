import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  nativeToolInputSchema,
  playwrightToolDefinitions,
  nativeObservationTools,
} from "@scry/contracts";
import { z } from "zod";
import { BrowserApiClient } from "./api-client.js";
import { uuid } from "./tool-registry.js";

export const nativeBrowserInstructions =
  "Use one Mission for the user's objective and an Environment containing only the assigned app origins. Resume a matching active Mission when present. Create a Flow and Run, then use browser tools with the Run's browserSessionId. Each actionId must be unique for a new action; reuse it only to retrieve that same action, never to perform another one. Current snapshots and browser_find provide current element targets. Use screenshots for visual checks; accessibility text alone does not prove layout or edited values. Normal browser errors are observations, not successful actions. UNKNOWN means an action may have happened: inspect the app or stop accurately, never repeat it blindly. Request explicit user selection before binding saved credentials; browser_type_secret accepts a bound opaque reference, not plaintext. Automatic black masking is best effort for access secrets and financial details, not a guarantee of complete protection. Native video preserves original UI and timing. Finish the Run and record findings factually before publishing the Mission report.";

export async function nativeCommandResult(
  client: BrowserApiClient,
  command: Record<string, unknown>,
) {
  const result = command.result as
    | {
        execution?: string;
        content?: Array<{ type: string; text?: string }>;
        media?: Array<{ artifactId: string }>;
      }
    | undefined;
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: JSON.stringify(command) }];
  if (result?.media?.length && typeof command.runId === "string") {
    try {
      const publication = await client.get<{
        items: Array<{ index: number; artifactId: string; kind: string }>;
      }>(`/runs/${command.runId}/media`);
      for (const media of result.media) {
        const item = publication.items.find(
          (item) => item.artifactId === media.artifactId && item.kind === "screenshot",
        );
        if (item) content.push(await client.getImage(`/runs/${command.runId}/media/${item.index}`));
      }
    } catch {
      content.push({
        type: "text",
        text: "The durable action result is retained, but its screenshot could not be retrieved. Inspect the Run evidence or retry get_command; do not repeat the action.",
      });
    }
  }
  return {
    content,
    structuredContent: { command },
    isError:
      command.state === "failed" ||
      result?.execution === "tool_error" ||
      result?.execution === "unknown",
  };
}

export function registerNativeBrowserTools(
  server: McpServer,
  client: BrowserApiClient,
  poll: (
    client: BrowserApiClient,
    id: string,
    ms: number,
  ) => Promise<Record<string, unknown> | undefined>,
) {
  const definitions = [
    ...playwrightToolDefinitions.map((d) => ({
      name: d.name,
      description: d.description,
      schema: nativeToolInputSchema(d.inputSchema) as z.ZodObject,
    })),
    {
      name: "browser_type_secret",
      description:
        "Type an explicitly user-selected credential already bound to this Run. The secret never appears in the tool arguments or response.",
      schema: z.strictObject({
        target: z.string().max(20000),
        protectedValueId: uuid,
        submit: z.boolean().optional(),
      }),
    },
  ];
  for (const d of definitions)
    server.registerTool(
      d.name,
      {
        description: d.description,
        inputSchema: {
          ...d.schema.shape,
          browserSessionId: uuid,
          actionId: z
            .string()
            .min(8)
            .max(256)
            .describe(
              "Stable identity of this one intended action; do not reuse for a different action.",
            ),
        },
        annotations: {
          readOnlyHint: nativeObservationTools.has(d.name),
          destructiveHint: !nativeObservationTools.has(d.name),
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input: Record<string, unknown>) => {
        const { browserSessionId, actionId, ...args } = input;
        const submitted = await client.post<{ commandId: string; state: string }>(
          `/browser-sessions/${browserSessionId}/commands`,
          {
            command: { kind: "browser_tool", tool: d.name, args },
            idempotencyKey: `mcp-native-${actionId}`,
          },
        );
        const command = await poll(client, submitted.commandId, 30000);
        return command
          ? nativeCommandResult(client, command)
          : {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    ...submitted,
                    message:
                      "Still queued or running. Read get_command; do not issue a replacement action.",
                  }),
                },
              ],
            };
      },
    );
}
