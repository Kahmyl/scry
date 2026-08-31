import { describe, expect, it } from "vitest";

import { compilePreparedProtectedOperation } from "../src/adaptive-sessions/prepared-protected-operation.compiler.js";

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

describe("prepared protected operation compiler", () => {
  it("consumes canonical semantics and output keys while using interaction-owned controls", () => {
    const result = compilePreparedProtectedOperation({
      entryUrl: "https://example.test/items",
      material: material("mutation"),
    });

    expect(result.transaction.mutation.request).toEqual({
      method: "POST",
      pathTemplate: "/items",
      transports: ["fetch"],
    });
    expect(result.transaction.mutation.action).toMatchObject({
      target: { authoritativeReference: "context-control-11111111111111111111111111111111" },
    });
    expect(result.transaction.mutation.response).toEqual({
      confirmedNotAppliedStatuses: [400, 401, 403, 422],
    });
    expect(result.transaction.extraction.outputs[0]).toMatchObject({
      reference: "itemId",
      classification: "public",
    });
  });

  it("makes mutation-only response policy absent for canonical read-only semantics", () => {
    const value = material("read_only");
    value.contractFacts.operation.method = "GET";
    value.contractFacts.response.mutationPolicy = undefined;
    const result = compilePreparedProtectedOperation({
      entryUrl: "https://example.test/items/item-1",
      material: value,
    });

    expect(result.transaction.mutation.dispatchSemantics).toBe("read_only");
    expect(result.transaction.mutation.response).toBeUndefined();
  });
});

function material(dispatch: "read_only" | "mutation") {
  return {
    protectedOperationId: id("1"),
    publicOperationId: "create-item-once",
    objectiveId: id("2"),
    flowDraftId: id("3"),
    preparedExecutionCapabilityId: id("4"),
    activationControlReference: "context-control-11111111111111111111111111111111",
    contractFacts: {
      application: { key: "example", provider: "example" },
      adapter: { key: "registered", version: 1 },
      operation: {
        key: "createItem",
        label: "Create item",
        method: "POST" as "GET" | "POST",
        pathTemplate: "/items",
        transports: ["fetch" as const],
        semantics: {
          dispatch,
          effects: dispatch === "read_only" ? ["read" as const] : ["business_effect" as const],
        },
      },
      inputs: [
        {
          key: "clientId",
          label: "Client ID",
          aliases: ["Customer"],
          required: true,
          classification: "public" as const,
          acceptedPresentations: ["plain_text" as const],
        },
        {
          key: "clientSecret",
          label: "Client secret",
          aliases: ["Password"],
          required: true,
          classification: "protected" as const,
          acceptedPresentations: ["protected_text" as const],
        },
      ],
      auth: { presentationClasses: ["protected_text" as const] },
      response: {
        statusClasses: [2],
        mutationPolicy:
          dispatch === "mutation"
            ? { confirmedNotAppliedStatuses: [400, 401, 403, 422] }
            : undefined,
        outputs: [
          {
            key: "itemId",
            label: "id",
            classification: "public" as const,
            extractor: { kind: "json_path" as const, path: "$.data.id" },
            identityRole: "resource_identity" as const,
            generatedValueEligible: true,
          },
        ],
        continuation: "read_only_retrieve" as const,
      },
      resourceEffect:
        dispatch === "mutation"
          ? {
              operation: "create" as const,
              provider: "example",
              resourceKind: "item",
              resourceScope: "application-1",
              identityContractVersion: 1,
              identityOutputKey: "itemId",
              correlationFieldKey: "clientId",
            }
          : undefined,
    },
    values: [
      {
        canonicalFieldKey: "clientId",
        targetReference: "context-control-22222222222222222222222222222222",
        presentationClass: "plain_text" as const,
        sourceKind: "literal_public" as const,
        sourceReferenceId: null,
        publicValue: "public-client",
        storedPublicValue: null,
      },
      {
        canonicalFieldKey: "clientSecret",
        targetReference: "context-control-33333333333333333333333333333333",
        presentationClass: "protected_text" as const,
        sourceKind: "protected_reference" as const,
        sourceReferenceId: id("5"),
        publicValue: null,
        storedPublicValue: null,
      },
    ],
    expectedOutputs: [
      { reference: "itemId", classification: "public" as const, storageName: "Create item itemId" },
    ],
  };
}
