import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Runs execute validated knowledge; Probe Sessions create it. Author capability-grounded intents in a mutable Flow draft, inspect every unresolved target and readiness transition in one Probe Session, compile the complete draft, and publish only an execution-ready immutable revision. Never create or revise immutable Flows directly. Never start a Run without the exact compiledContractId returned at publication. Read get_run.praxis for typed provenance, retry disposition, mutation outcome, safe actions, findings, and artifacts. Never retry an unknown mutation or infer safety from prose. Structural or intent failures return to revision or calibration; policy, privacy, environment, and infrastructure failures follow their typed safe actions. Describe behavior, evidence, scope, prohibited states, risk, and effects—never selectors, test IDs, pixels, or arbitrary coordinates. Mission readiness, authorization, privacy, protected acquisition, and evidence acceptance remain authoritative. Check capabilities before authoring.";

export function createScryServerComposition() {
  return new McpServer({ name: "scry", version: "1.0.0" }, { instructions: SCRY_MCP_INSTRUCTIONS });
}
