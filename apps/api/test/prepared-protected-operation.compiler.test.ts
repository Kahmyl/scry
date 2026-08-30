import { describe, expect, it } from "vitest";

import { compilePreparedProtectedOperation } from "../src/adaptive-sessions/prepared-protected-operation.compiler.js";

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

describe("prepared protected operation compiler", () => {
  it("uses canonical keys, typed values, exact controls, and the observed network contract", () => {
    const result = compilePreparedProtectedOperation({
      entryUrl: "https://example.test/items",
      material: {
        protectedOperationId: id("1"),
        publicOperationId: "create-item-once",
        objectiveId: id("2"),
        flowDraftId: id("3"),
        authorizationId: id("4"),
        contractFacts: {
          operation: {
            key: "createItem",
            label: "Create item",
            method: "POST",
            pathTemplate: "/items",
            transports: ["fetch"],
            classification: "mutation",
            activationControlReference: "context-control-11111111111111111111111111111111",
          },
          inputs: [
            {
              key: "clientId",
              label: "Client ID",
              aliases: ["Customer"],
              required: true,
              classification: "public",
              acceptedPresentations: ["plain_text"],
              controlReference: "context-control-22222222222222222222222222222222",
            },
            {
              key: "clientSecret",
              label: "Client secret",
              aliases: ["Password"],
              required: true,
              classification: "protected",
              acceptedPresentations: ["protected_text"],
              controlReference: "context-control-33333333333333333333333333333333",
            },
          ],
          response: {
            statusClasses: [2],
            confirmedNotAppliedStatuses: [400, 401, 403, 422],
            safeOutputKeys: ["itemId"],
            safeOutputs: [{ key: "itemId", label: "id", classification: "public" }],
            publicIdentityOutputPath: "$.itemId",
            continuation: "read_only_retrieve",
          },
          resourceEffect: {
            operation: "create",
            provider: "example",
            resourceKind: "item",
            resourceScope: "application-1",
            identityContractVersion: 1,
            identityOutputKey: "itemId",
            correlationFieldKey: "clientId",
          },
        },
        values: [
          {
            canonicalFieldKey: "clientId",
            targetReference: "context-control-22222222222222222222222222222222",
            presentationClass: "plain_text",
            sourceKind: "literal_public",
            sourceReferenceId: null,
            publicValue: "public-client",
            storedPublicValue: null,
          },
          {
            canonicalFieldKey: "clientSecret",
            targetReference: "context-control-33333333333333333333333333333333",
            presentationClass: "protected_text",
            sourceKind: "protected_reference",
            sourceReferenceId: id("5"),
            publicValue: null,
            storedPublicValue: null,
          },
        ],
        expectedOutputs: [{ key: "itemId", classification: "public" }],
      },
    });

    expect(result.transaction.mutation.request).toEqual({
      method: "POST",
      pathTemplate: "/items",
      transports: ["fetch"],
    });
    expect(result.transaction.mutation.action).toMatchObject({
      target: {
        authoritativeReference: "context-control-11111111111111111111111111111111",
      },
    });
    expect(Object.values(result.transaction.inputs)).toEqual(
      expect.arrayContaining([
        { classification: "public", value: "public-client" },
        { classification: "known_secret", credentialRef: id("5") },
      ]),
    );
    expect(result.transaction.extraction.outputs[0]).toMatchObject({
      reference: "itemId",
      classification: "public",
    });
    expect(result.transaction.extraction.externalResourceBindings).toEqual([
      expect.objectContaining({
        identityReference: "itemId",
        provider: "example",
        resourceScope: "application-1",
      }),
    ]);
    expect(result.intent.action).toMatchObject({
      resourceEffect: {
        correlation: { field: "clientId", value: "public-client" },
      },
    });
  });
});
