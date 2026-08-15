import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attachRunPraxisSessionSchema,
  dispatchRunOperationBaseSchema,
  finalizeAgentDirectedRunSchema,
} from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, uuid, writes } from "../../tool-registry.js";

export function registerAgentDirectedRunTools(server: McpServer, client: ScryApiClient) {
  server.registerTool("dispatch_run_operation", {
    title: "Dispatch one Run operation",
    description: "Dispatch exactly one external-agent-selected operation through the Run's currently associated live Praxis session. Every target requires a fresh opaque context-control reference from that session. Scry records facts and never chooses a continuation.",
    inputSchema: { runId: uuid, ...dispatchRunOperationBaseSchema.shape }, annotations: writes,
  }, async ({ runId, ...input }) => {
    await client.requireCurrentRelease();
    return toolResult({ result: await client.post(`/runs/${runId}/operations`,input) },"Operation facts recorded; the external agent chooses what happens next.");
  });
  server.registerTool("attach_run_praxis_session", {
    title: "Attach a new live Praxis session",
    description: "Attach a new live Praxis session epoch after session loss. Old references remain stale; re-observe before dispatch.",
    inputSchema: { runId: uuid, ...attachRunPraxisSessionSchema.shape }, annotations: writes,
  }, async ({ runId, ...input }) => {
    await client.requireCurrentRelease();
    return toolResult({ binding: await client.post(`/runs/${runId}/praxis-session`,input) },"New Praxis session epoch attached; re-observation is required.");
  });
  server.registerTool("finalize_run", {
    title: "Finalize Run",
    description: "Explicitly finalize an agent-directed Run after the external agent interprets the recorded operation facts.",
    inputSchema: { runId: uuid, ...finalizeAgentDirectedRunSchema.shape }, annotations: writes,
  }, async ({ runId, ...input }) => {
    await client.requireCurrentRelease();
    return toolResult({ run: await client.post(`/runs/${runId}/finalize`,input) },"Run finalized explicitly.");
  });
}
