import { describe, expect, it } from "vitest";

import { SCRY_MCP_INSTRUCTIONS } from "../src/server-composition.js";

describe("external-agent factual provenance guidance", () => {
  it("keeps tool facts separate from unsupported causal inference", () => {
    expect(SCRY_MCP_INSTRUCTIONS).toContain("Treat MCP tool results as factual observations");

    expect(SCRY_MCP_INSTRUCTIONS).toContain("distinguish returned facts from your inferences");

    expect(SCRY_MCP_INSTRUCTIONS).toContain(
      "do not infer an error's causal layer, responsible subsystem, or category unless the tool result explicitly identifies it",
    );
  });
});
