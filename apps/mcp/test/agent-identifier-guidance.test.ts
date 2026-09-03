import { describe, expect, it } from "vitest";

import { SCRY_MCP_INSTRUCTIONS } from "../src/server-composition.js";

describe("external-agent identifier guidance", () => {
  it("forbids invented identifiers and enum values", () => {
    expect(SCRY_MCP_INSTRUCTIONS).toContain(
      "Never invent identifiers, placeholder identifiers, or enum values",
    );

    expect(SCRY_MCP_INSTRUCTIONS).toContain(
      "use exact identifiers returned by Scry and exact enum literals admitted by the tool schema",
    );
  });
});
