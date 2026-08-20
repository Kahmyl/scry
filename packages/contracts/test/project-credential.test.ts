import { describe, expect, it } from "vitest";

import { createCredentialSchema, updateCredentialSchema } from "../src/index.js";

const context = {
  missionId: "11111111-1111-4111-8111-111111111111",
  objectiveId: "22222222-2222-4222-8222-222222222222",
  agentSessionId: "33333333-3333-4333-8333-333333333333",
};

describe("Project credential contracts", () => {
  it("allows Project-owned creation without Mission provenance", () => {
    expect(
      createCredentialSchema.safeParse({ name: "Reusable login", value: "secret" }).success,
    ).toBe(true);
  });

  it("accepts complete optional provenance and rejects partial Mission coupling", () => {
    expect(
      createCredentialSchema.safeParse({ ...context, name: "Agent supplied", value: "secret" })
        .success,
    ).toBe(true);
    expect(
      createCredentialSchema.safeParse({
        missionId: context.missionId,
        name: "Invalid partial context",
        value: "secret",
      }).success,
    ).toBe(false);
  });

  it("keeps credential updates Project-scoped while accepting the legacy complete context", () => {
    expect(
      updateCredentialSchema.safeParse({ name: "Renamed", value: "replacement" }).success,
    ).toBe(true);
    expect(
      updateCredentialSchema.safeParse({ ...context, name: "Renamed", value: "replacement" })
        .success,
    ).toBe(true);
    expect(
      updateCredentialSchema.safeParse({
        missionId: context.missionId,
        name: "Invalid partial context",
        value: "replacement",
      }).success,
    ).toBe(false);
  });
});
