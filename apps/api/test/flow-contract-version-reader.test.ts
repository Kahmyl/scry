import { describe, expect, it } from "vitest";

import { readImmutableFlowContractVersion } from "../src/flows/flow.service.js";

describe("immutable Flow contract-version reader", () => {
  it("reads learned contracts for immutable revisions", () => {
    expect(readImmutableFlowContractVersion("v2-learned-interactions", "revision-1"))
      .toBe("v2-learned-interactions");
  });

  it("permits legacy compatibility only for an existing immutable revision", () => {
    expect(readImmutableFlowContractVersion("v1-existing", "revision-legacy"))
      .toBe("v1-existing");
    try {
      readImmutableFlowContractVersion("v1-existing", null);
      throw new Error("expected compatibility rejection");
    } catch (error) {
      expect(error).toMatchObject({ response: { code: "UNSUPPORTED_FLOW_CONTRACT_VERSION" } });
    }
  });
});
