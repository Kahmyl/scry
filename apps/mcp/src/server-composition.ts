import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Adaptive Sessions are the preferred mission-independent authoring surface. Mission, Objective, Flow draft, and Probe tools remain compatibility adapters for product control-plane workflows; they do not own or duplicate execution. Runs execute validated knowledge. Never create or revise immutable Flows directly. Never start a Run without the exact compiledContractId returned at publication. Read typed outcomes for provenance, retry disposition, mutation outcome, safe actions, findings, and artifacts. Never retry an unknown mutation or infer safety from prose. Structural or intent failures return to revision or calibration; policy, privacy, environment, and infrastructure failures follow their typed safe actions. Describe behavior, evidence, scope, prohibited states, risk, and effects—never selectors, test IDs, pixels, or arbitrary coordinates. Authorization, privacy, protected acquisition, and evidence acceptance remain authoritative. Check capabilities before state-changing authoring.";

export function createScryServerComposition() {
  return new McpServer({ name: "scry", version: "1.0.0" }, { instructions: SCRY_MCP_INSTRUCTIONS });
}
