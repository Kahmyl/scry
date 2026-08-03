import { describe, expect, it } from "vitest";

import { classifyOriginalAfterConfirmation } from "../src/runtime/index.js";

describe("confirmation classification", () => {
  it("does not convert a reproduced readiness timeout into a product failure", () => {
    expect(classifyOriginalAfterConfirmation("failed", "readiness_timeout")).toBe(
      "readiness_timeout",
    );
  });

  it("confirms only a reproduced semantic assertion failure", () => {
    expect(classifyOriginalAfterConfirmation("failed", "assertion_failure")).toBe(
      "confirmed_product_failure",
    );
  });

  it("marks a passing confirmation as non-reproduced", () => {
    expect(classifyOriginalAfterConfirmation("passed", "passed")).toBe("non_reproduced_failure");
  });
});
