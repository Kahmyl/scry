import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Direct Sessions are the preferred exploratory browser surface. Use start_direct_session, execute_direct_turn, observe_direct_session, and close_direct_session for live testing without Mission, Flow, Probe, Praxis, Veil, compilation, or Run prerequisites. Use role, label, placeholder, text, or test-id targets; never arbitrary JavaScript, CSS selectors, coordinates, or plaintext credentials. Credential values must use fillCredential references and are never returned. Never automatically repeat an action whose dispatchState is dispatched. Adaptive Sessions and deterministic Runs remain optional downstream qualification paths after a direct journey succeeds.";

export function createScryServerComposition() {
  return new McpServer({ name: "scry", version: "1.0.0" }, { instructions: SCRY_MCP_INSTRUCTIONS });
}
