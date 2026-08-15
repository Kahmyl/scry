import { describe, expect, it } from "vitest";

import { dispatchRunOperationSchema } from "../src/flow.js";

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function command(reference?: string, praxisSessionId = id("1")) {
  return {
    praxisSessionId,
    intent: {
      intentId: "activate-submit",
      objectiveId: id("2"),
      flowDraftId: id("3"),
      action: {
        kind: "activate",
        target: { concept: "Submit", ...(reference ? { reference } : {}), role: "button" },
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    },
  };
}

describe("agent-directed Run live Praxis binding", () => {
  it("requires an exact live reference for every target-bearing operation", () => {
    expect(dispatchRunOperationSchema.safeParse(command()).success).toBe(false);
    expect(
      dispatchRunOperationSchema.parse(command(`context-control-${"a".repeat(32)}`)).intent.action,
    ).toMatchObject({ kind: "activate" });
  });

  it("carries an explicit dispatch session identity independently of target semantics", () => {
    const parsed = dispatchRunOperationSchema.parse(
      command(`context-control-${"b".repeat(32)}`, id("4")),
    );
    expect(parsed.praxisSessionId).toBe(id("4"));
  });
});
