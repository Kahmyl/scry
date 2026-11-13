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
        "Validate the customer-visible report before final publication. Typed presentation.sections retain safe API coverage, cleanup and receipt detail; blocked/excluded statuses stay separate. Extra safeReport keys are operator-only and will NOT appear in the customer report. This preview is not privacy certification; the API sanitizes on publication. Final reports are immutable; replay returns the existing report without changing it.",
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
        "After list_projects, call this before testing and follow returned workflowGuidance. Load the Project’s Missions, Environments and safe credential metadata in one call. Server capabilities do not prove host tool exposure. Reuse explicit user credential choices; never infer permission from names.",
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
        "Create/reuse one objective, Flow and Run for a known current Mission in one call. Select the assigned Environment first. Reuse the same attemptId and inputs to recover a partial/lost response; change attemptId only for a deliberately new attempt. Does not choose credentials or start application actions.",
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
        "Read terminal status, pending-command count, current owner generation and explicit browserReleased for one Run. This is execution state, never an application pass. Use after finalization instead of inferring release from a closed chat.",
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
        "Stop an explicitly selected incomplete attempt through the supported fenced finalizer, preserving evidence and uncertain outcomes. Never marks a test passed or replays application writes. Confirmed must represent authorization to stop this attempt. Returns explicit release facts; if closure is pending or fenced, inspect get_run_status rather than repeatedly stopping.",
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
