import { describe, expect, it, vi } from "vitest";

import { persistAcquiredProtectedOutputs } from "../src/protected-transaction-acquisition.js";

describe("protected output persistence routing", () => {
  it("routes a mixed Run output set through one atomic authority and never legacy captures", async () => {
    const persistSecret = vi.fn();
    const persistPublicValue = vi.fn();
    const persistOutputsAtomically = vi.fn(async ({ claim, outputs }) => ({
      claim: { ...claim, state: "persisted" as const, version: claim.version + 1 },
      references: {
        secret: { classification: "protected" as const, credentialId: "secret-id", scope: "run" as const },
        public: { classification: "public" as const, valueId: "value-id", scope: "run" as const },
      },
      outputs,
    }));
    const acquired = [
      { output: { reference: "secret", classification: "protected", storage: { credentialName: "Secret", scope: "run" } }, value: "synthetic-secret", adapter: "semantic_field_value" },
      { output: { reference: "public", classification: "public", storage: { name: "Public", scope: "run" } }, value: "public-value", adapter: "semantic_field_value" },
    ];
    const facts = {
      credentialReferences: {}, publicValueReferences: {}, protectedAcquisitionEvidence: [],
      protectedPersistence: "not_attempted", publicPersistence: "not_attempted",
      credentialSecurity: "not_applicable",
    };
    const claim = { id: "operation", state: "persisting" as const, version: 7, fencingToken: 3 };
    const result = await persistAcquiredProtectedOutputs(
      { operationId: "generate", extraction: { outputs: acquired.map(({ output }) => output) } } as never,
      { persistSecret, persistPublicValue, persistOutputsAtomically } as never,
      facts as never,
      acquired as never,
      claim,
    );
    expect(result.state).toBe("persisted");
    expect(persistOutputsAtomically).toHaveBeenCalledOnce();
    expect(persistOutputsAtomically.mock.calls[0]?.[0].outputs.map((output: { scope: string }) => output.scope)).toEqual(["run", "run"]);
    expect(persistSecret).not.toHaveBeenCalled();
    expect(persistPublicValue).not.toHaveBeenCalled();
    expect(acquired.every(({ value }) => value === "")).toBe(true);
  });

  it("fails the whole set and clears every value when atomic persistence rejects", async () => {
    const acquired = [
      { output: { reference: "secret", classification: "protected", storage: { credentialName: "Secret", scope: "run" } }, value: "synthetic-secret", adapter: "semantic_field_value" },
      { output: { reference: "public", classification: "public", storage: { name: "Public", scope: "run" } }, value: "public-value", adapter: "semantic_field_value" },
    ];
    await expect(persistAcquiredProtectedOutputs(
      { operationId: "generate", extraction: { outputs: acquired.map(({ output }) => output) } } as never,
      { persistOutputsAtomically: vi.fn(async () => { throw new Error("database unavailable"); }) } as never,
      { credentialReferences: {}, publicValueReferences: {}, protectedAcquisitionEvidence: [], protectedPersistence: "not_attempted", publicPersistence: "not_attempted", credentialSecurity: "not_applicable" } as never,
      acquired as never,
      { id: "operation", state: "persisting", version: 7, fencingToken: 3 },
    )).rejects.toThrow("ATOMIC_OUTPUT_PERSISTENCE_FAILED");
    expect(acquired.every(({ value }) => value === "")).toBe(true);
  });
});
