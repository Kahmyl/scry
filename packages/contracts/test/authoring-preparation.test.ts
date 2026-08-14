import { describe, expect, it } from "vitest";

import { prepareFlowAuthoringSchema } from "../src/index.js";

describe("deterministic authoring preparation contract", () => {
  it("requires an explicit create or exact reuse decision", () => {
    expect(prepareFlowAuthoringSchema.parse({
      kind: "reuse",
      projectId: "11111111-1111-4111-8111-111111111111",
      authoringSessionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "reuse-authoring-session",
    })).toMatchObject({ kind: "reuse" });
    expect(() => prepareFlowAuthoringSchema.parse({
      kind: "reuse",
      projectId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "implicit-selection",
    })).toThrow();
  });
});
