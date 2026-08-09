import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeDirectTurnSchema, startDirectSessionSchema } from "@scry/contracts";
import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult, uuid, writes } from "../../tool-registry.js";

export function registerDirectSessionTools(server: McpServer, client: ScryApiClient) {
  server.registerTool("start_direct_session", {
    title: "Start Direct Browser Session",
    description: "Start the preferred lightweight exploratory browser session. This does not create Mission, Flow, Probe, Run, Praxis, Veil, or compilation state.",
    inputSchema: startDirectSessionSchema.shape,
    annotations: writes,
  }, async (input) => toolResult({ session: await client.post("/direct-sessions", startDirectSessionSchema.parse(input)) }, "Direct browser session started."));

  server.registerTool("execute_direct_turn", {
    title: "Execute Direct Browser Turn",
    description: "Execute up to ten direct Playwright actions in one persistent browser. Credential values are resolved inside Scry and never returned. Failed dispatched actions are never automatically retried.",
    inputSchema: { sessionId: uuid, actions: executeDirectTurnSchema.shape.actions, timeoutMs: executeDirectTurnSchema.shape.timeoutMs.optional() },
    annotations: writes,
  }, async ({ sessionId, ...input }) => toolResult({ session: await client.post(`/direct-sessions/${sessionId}/turns`, executeDirectTurnSchema.parse(input)) }, "Direct browser turn completed."));

  server.registerTool("observe_direct_session", {
    title: "Observe Direct Browser Session",
    description: "Read one compact safe observation from the active direct browser without changing page state.",
    inputSchema: { sessionId: uuid }, annotations: readOnly,
  }, async ({ sessionId }) => toolResult({ session: await client.get(`/direct-sessions/${sessionId}`) }, "Direct browser session observed."));

  server.registerTool("close_direct_session", {
    title: "Close Direct Browser Session",
    description: "Close the direct browser and return its sanitized in-memory transcript.",
    inputSchema: { sessionId: uuid }, annotations: writes,
  }, async ({ sessionId }) => toolResult({ session: await client.delete(`/direct-sessions/${sessionId}`) }, "Direct browser session closed."));
}
