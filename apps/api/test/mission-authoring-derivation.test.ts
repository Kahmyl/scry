import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { deriveMissionAuthoringOperation } from "../src/adaptive-sessions/mission-authoring-derivation.js";

const ids = { objectiveId: randomUUID(), flowDraftId: randomUUID(), turnId: randomUUID() };
const target = { concept: "control", role: "button" as const, name: "Control", testId: "control-id" };

function derive(action: Record<string, unknown>) {
  return deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: {
    intentId: `intent-${String(action.kind)}`, ...ids, action, expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" }, protectedInputReferences: [],
  } as never });
}

describe("Mission authoring semantic derivation", () => {
  it("derives action-specific capabilities and typed test-ID evidence", () => {
    expect((derive({ kind: "fill", target, publicValue: "value" }).action as any).target.requiredCapabilities)
      .toEqual(["focusable", "accepts_text", "editable"]);
    expect((derive({ kind: "activate", target }).action as any).target.requiredCapabilities)
      .toEqual(["focusable", "pointer_activatable"]);
    expect((derive({ kind: "select", target, value: "value" }).action as any).target.requiredCapabilities)
      .toEqual(["focusable", "selects_option"]);
    expect((derive({ kind: "set_checked", target, checked: true }).action as any).target.requiredCapabilities)
      .toEqual(["focusable", "toggleable"]);
    expect((derive({ kind: "fill", target, publicValue: "value" }).action as any).target.preferredEvidence.testIds)
      .toEqual(["control-id"]);
  });

  it("preserves new-page ownership as a distinct internal effect", () => {
    const derived = deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: {
      intentId: "popup", ...ids, action: { kind: "activate", target },
      expectedEffect: { kind: "new_page", origin: "https://example.test" },
      constraints: { timeoutMs: 1_000, allowNewPage: true, allowNonExact: false },
      authorization: { kind: "ordinary" }, protectedInputReferences: [],
    } as never });
    expect(derived.expectedEffect).toEqual({ type: "new_page", origin: "https://example.test" });
  });
});
