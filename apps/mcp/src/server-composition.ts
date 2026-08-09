import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Mission is mandatory for all Scry authoring and execution. Create or resume one Mission, add an Objective, create its owned Flow draft, then start and advance Mission-owned authoring. Use semantic role, label, placeholder, text, test-id, dialog, section, row, or live-region targets; never arbitrary JavaScript, selectors, coordinates, handles, or plaintext credentials. Protected values use encrypted references and are never returned. Server-owned grouped turns wait to a typed terminal boundary; do not poll or automatically repeat an operation after dispatch begins. Every published Flow revision and deterministic Run remains owned by its Mission and Objective.";

export function createScryServerComposition() {
  return new McpServer({ name: "scry", version: "1.0.0" }, { instructions: SCRY_MCP_INSTRUCTIONS });
}
