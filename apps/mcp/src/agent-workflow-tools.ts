import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserApiClient } from "./api-client.js";
import {
  localFactualRead,
  idempotentDurableWrite,
  stableKey,
  toolResult,
  uuid,
} from "./tool-registry.js";
import { toolAuthMetadata } from "./oauth-discovery.js";
import {
  applicationReportPresentationSchema,
  publishBrowserMissionReportSchema,
  prepareBrowserJourneySchema,
  testingContextRequestSchema,
  canonicalFeedback,
  contextFeedback,
  releaseFeedback,
} from "@scry/contracts";

/** Convenience operations reuse the same scoped APIs and idempotency rules. */
export function registerAgentWorkflowTools(
  server: McpServer,
  client: BrowserApiClient,
  native: boolean,
  workflowGuidance: string,
) {
  server.registerTool(
    "get_connection_diagnostics",
    {
      description:
        "Read safe server authorization/discovery facts for this connection. Optionally supply tool names actually exposed in this chat; those are explicitly client-reported, not server verification. Distinguishes valid access, stored grant/client registration and missing host tools. Does not reinstall, reconnect or grant permission. If this tool is absent, use Scry's dashboard connection diagnostics instead; do not repeatedly ask users to select a missing plugin.",
      inputSchema: {
        observedToolNames: z
          .array(z.string().regex(/^[A-Za-z0-9_]{1,100}$/))
          .max(200)
          .optional(),
      },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ observedToolNames }) => {
      const required = [
        "list_projects",
        "get_testing_context",
        "start_journey",
        "get_run_status",
        "finish_incomplete_run",
        "publish_mission_report",
        ...(native ? ["browser_snapshot", "browser_sequence"] : []),
      ];
      return toolResult(
        {
          ...(await client.get<Record<string, unknown>>("/integrations/diagnostics")),
          requiredTools: required,
          ...(observedToolNames
            ? {
                clientReport: {
                  source: "client_supplied_unverified",
                  missingRequiredTools: required.filter((n) => !observedToolNames.includes(n)),
                },
              }
            : {}),
        },
        "This authenticated request succeeded. Host tool discovery is a separate fact; preserve successful credentials while investigating it.",
      );
    },
  );
  server.registerTool(
    "preview_mission_report",
    {
      description:
        "Preview customer-visible presentation.sections before immutable publication. Extra safeReport keys are operator-only. Preserve blocked/excluded scope; preview is not privacy certification.",
      inputSchema: publishBrowserMissionReportSchema.omit({ agentSessionId: true }).shape,
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async (input) => {
      const p = applicationReportPresentationSchema.safeParse(input.safeReport.presentation);
      return toolResult(
        {
          valid: p.success,
          customerPresentation: p.success ? p.data : null,
          operatorOnlyFields: Object.keys(input.safeReport)
            .filter((k) => k !== "presentation")
            .slice(0, 30),
          finalReportImmutable: true,
        },
        p.success
          ? "Customer-visible report validated. Review all detail sections before publication."
          : "No valid application presentation; classify actual application checks before publication.",
      );
    },
  );
  server.registerTool(
    "get_testing_context",
    {
      description:
        "After list_projects, load Project Missions, Environments and safe credential metadata together. Follow returned workflowGuidance. Capability is not host exposure or credential permission.",
      inputSchema: testingContextRequestSchema.shape,
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async (input) => {
      const context = await client.post<Record<string, unknown>>("/testing-context", input);
      const interaction = canonicalFeedback(context.interaction) ?? contextFeedback(context);
      return toolResult({ ...context, interaction, workflowGuidance }, interaction.summary);
    },
  );
  server.registerTool(
    "start_journey",
    {
      description:
        "Create/reuse an objective, Flow and Run in the current Mission/selected Environment. Retry identical inputs with the same attemptId after lost responses. Does not select credentials or act on the app.",
      inputSchema: prepareBrowserJourneySchema.shape,
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async (input) => {
      return toolResult(
        await client.post("/journeys", input),
        "Journey prepared atomically. Observe the application and check restoration prerequisites before changing access.",
      );
    },
  );
  server.registerTool(
    "get_run_status",
    {
      description:
        "Read terminal state, pending commands, privacy gaps and explicit browserReleased. Execution state is not an application verdict.",
      inputSchema: { runId: uuid },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ runId }) => {
      const status = await client.get<Record<string, unknown>>(`/runs/${runId}/status`);
      const interaction = releaseFeedback(status);
      return toolResult({ ...status, interaction }, interaction.summary);
    },
  );
  server.registerTool(
    "finish_incomplete_run",
    {
      description:
        "Stop the selected incomplete attempt with confirmed authorization, preserving evidence and uncertainty. No replay or passing verdict. Use returned release facts; if pending inspect get_run_status.",
      inputSchema: {
        runId: uuid,
        confirmed: z.literal(true),
        conclusion: z.string().min(1).max(4000),
      },
      _meta: toolAuthMetadata(),
      annotations: { ...idempotentDurableWrite, destructiveHint: true },
    },
    async ({ runId, ...input }) => {
      const stopped = await client.post<Record<string, unknown>>(`/runs/${runId}/stop`, input);
      const status = await client.get<Record<string, unknown>>(`/runs/${runId}/status`);
      const interaction = releaseFeedback(status);
      return toolResult(
        { ...stopped, ...status, interaction },
        interaction.state === "release_confirmed"
          ? "Incomplete attempt ended; browser release confirmed. Reuse this receipt; no immediate status reread is needed."
          : interaction.summary,
      );
    },
  );
}
