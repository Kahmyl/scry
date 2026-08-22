import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SCRY_MCP_INSTRUCTIONS =
  "Scry is an agent-directed browser execution system. Project, Mission, Flow, and Run are durable representation; they do not reason or choose progression. Start or reuse a live Praxis session, observe it, and select an exact opaque context-control reference from the current observation. References are scoped to the Praxis session, Page, and document that created them: never guess, translate, semantically re-resolve, or reuse one after session loss or document replacement. Open a Run ledger bound to that live session, dispatch exactly one bounded externally chosen operation, interpret the factual functional/mutation/privacy/evidence result, then explicitly choose another operation or finalize the Run. UNKNOWN means dispatch may have occurred and forbids silent retry. A dead session makes its references permanently stale; attach a new session to the durable Run, re-observe, and use new references. Do not call get_capabilities as a routine preflight: use it only when release or capability facts are requested, contract compatibility is uncertain, or a Scry error explicitly directs you to verify the release. Ordinary operations require neither compilation, certification, calibration, nor authorization ceremony. Protected or irreversible operations additionally require an explicit factually scoped authorization and an independent Veil permit. Expected effects are optional mechanical assertions only and never progression authority.";

export const SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS =
  "Observed semanticPageContext is bounded factual context. containerReferences explain privacy-safe grouping but are not action targets or resource identity. Never select by list order or infer identity from opaque references; request clarification when public facts do not establish the intended control.";

export function createScryServerComposition() {
  return new McpServer(
    { name: "scry", version: "1.0.0" },
    { instructions: `${SCRY_MCP_INSTRUCTIONS} ${SCRY_STRUCTURAL_CONTEXT_INSTRUCTIONS}` },
  );
}
