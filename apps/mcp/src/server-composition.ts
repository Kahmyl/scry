import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Mission is mandatory for all Scry authoring and execution. For a fresh project: list or create the encrypted credentials explicitly supplied by the user, create an approved environment whose policy allows the target origin, authorize only credentials needed by protected fills, create or resume one Mission, add an Objective, create its environment-owned Flow draft, then start and advance Mission-owned authoring. Public navigation and inspection do not require credentials. Use semantic role, accessible name, label, placeholder, text, test-id, dialog, section, row, or live-region targets; role-only inspection is supported when the role is the only known observable fact. Never use arbitrary JavaScript, selectors, coordinates, handles, or plaintext credentials in authoring intents. Protected values use encrypted references and are never returned. Server-owned grouped turns wait to a typed terminal boundary; do not poll or automatically repeat an operation after dispatch begins. After persisting a terminal decision, resume pointer, or final report, always call end_agent_session. Every published Flow revision and deterministic Run remains owned by its Mission and Objective.";

export function createScryServerComposition() {
  return new McpServer({ name: "scry", version: "1.0.0" }, { instructions: SCRY_MCP_INSTRUCTIONS });
}
