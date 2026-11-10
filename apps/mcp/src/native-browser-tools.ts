import { toolAuthMetadata } from "./oauth-discovery.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  playwrightToolDefinitions,
  nativeObservationTools,
  editBrowserTextSchema,
  nativeBrowserToolSchema,
  nativeCapabilitySchemas,
} from "@scry/contracts";
import { z } from "zod";
import { BrowserApiClient } from "./api-client.js";
import { uuid } from "./tool-registry.js";

export const nativeBrowserInstructions =
  "Use one Mission for the user's objective and an Environment containing only the assigned app origins. Resume a matching active Mission when present. Give each Flow a meaningful testing purpose and each Run an accurate conclusion, keeping failed or recovered attempts visible. Use browser tools with the Run's browserSessionId. Each actionId must be unique for a new action; reuse it only to retrieve that same action, never to perform another one. Current snapshots and browser_find provide current element targets. Use screenshots for visual checks; accessibility text alone does not prove layout or edited values. For rich text use browser_edit_text with explicit replace/insert intent and keyboard/paste method. Its readback is input observation, not proof of saved state; verify persistence separately. browser_type with slowly=true inserts rather than clears. Normal browser errors are observations, not successful actions. UNKNOWN means an action may have happened: inspect the app or stop accurately, never repeat it blindly. Request explicit user selection before binding saved credentials; browser_type_secret accepts a bound opaque reference, not plaintext. Automatic opaque frosted masking is best effort for access secrets and financial details, not a guarantee of complete protection. Native video preserves original UI and timing without a fixed journey time cutoff. Capture meaningful changed states, not repeated identical screenshots, and provide evidenceTitle/evidenceDescription when helpful. Finish the Run and publish a factual Mission report with verified scope, observations, evidence references and limitations. The report links the same evidence as the Mission, not a second copy.";

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
    structuredContent: { message: "Browser command facts loaded.", command },
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
    ...Object.entries(nativeCapabilitySchemas).map(([name, schema]) => ({
      name,
      schema,
      description: (
        {
          browser_scoped_request:
            "Run one scoped HTTP request in this Run's existing durable worker lane. Requires API capability. Only Environment origins and approved network destinations; no automatic redirects/retries or browser cookie reuse. Credentials and sensitive body fields use explicitly bound protectedValueId references. Response size/time are bounded; sensitive response fields are redacted and are not new reusable credentials. Status/transport completion is not business success. A write can have happened when response is unknown; never replay under a different actionId.",
          browser_list_downloads:
            "Read bounded download completion facts captured by this browser Session. Pending is not completed; no private file paths or file contents are returned. Use browser_verify_download on the returned ID, then include its durable receipt in the report.",
          browser_verify_download:
            "Verify an actual completed download against optional hash, size, suggested filename and format expectations. Facts come from bounded bytes after completion, not a successful click. Does not expose/download the file contents. A mismatch is a testing observation, not automatic proof of an application defect.",
          browser_set_viewport:
            "Set a supported desktop, mobile, mobile_landscape or tablet viewport in the owned browser. This changes viewport dimensions only, not user-agent/touch/device hardware. Recording stays on the fixed private 1280x720 canvas with unused padding; no viewport content may be cropped. Inspect returned actual dimensions and take a screenshot for visual checks. Desktop resets the viewport. Invalidates old observations.",
        } as Record<string, string>
      )[name]!,
    })),
    ...playwrightToolDefinitions.map((d) => ({
      name: d.name,
      description: d.description,
      schema: nativeBrowserToolSchema(d.name),
    })),
    {
      name: "browser_edit_text",
      description:
        "Edit text through the browser's native keyboard or private clipboard, with explicit replace/insert intent and an owned current reference. Useful for rich editors that reject fill. Reports observed input, not saved business success. On mismatch or uncertainty inspect the app before choosing another action; never blindly replay. Ordinary browser_type keeps Playwright semantics: slowly=true inserts at the selection, it does not clear implicitly.",
      schema: editBrowserTextSchema,
    },
    {
      name: "browser_navigate_secret",
      description:
        "Open a bound opaque access-link reference, such as a test invitation or password-reset URL. The ordinary Run origin and redirect policy still applies. Never use an email link as authority to add unrelated origins. The URL is not returned or placed in tool arguments.",
      schema: z.strictObject({ protectedValueId: uuid }),
    },
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
        description:
          d.description +
          (nativeObservationTools.has(d.name)
            ? " Scry queues this observation as a durable action and saves its result." +
              (d.name === "browser_take_screenshot"
                ? " Screenshot images persist as Run evidence."
                : "")
            : ""),
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
        _meta: toolAuthMetadata(),
        annotations: {
          // Observing the target still queues work and persists state in Scry.
          readOnlyHint: false,
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
