import { describe, expect, it } from "vitest";

import {
  missionContinuationSchema,
  operationContractFactsSchema,
  reservePreparedProtectedOperationSchema,
} from "../src/index.js";

const id = (last: string) => `00000000-0000-4000-8000-${last.padStart(12, "0")}`;
const hash = (character: string) => character.repeat(64);

const facts = {
  application: { key: "example", provider: "example" },
  adapter: { key: "generic_semantic", version: 1 },
  operation: {
    key: "retrieveOrder",
    label: "Retrieve order",
    method: "GET" as const,
    pathTemplate: "/orders/{orderId}",
    transports: ["fetch" as const],
    semantics: { dispatch: "read_only" as const, effects: ["read" as const] },
  },
  inputs: [
    {
      key: "orderId",
      label: "Order ID",
      aliases: ["Order ID"],
      required: true,
      classification: "generated_safe" as const,
      acceptedPresentations: ["plain_text" as const],
    },
  ],
  auth: { presentationClasses: [] },
  response: {
    statusClasses: [2],
    outputs: [
      {
        key: "orderId",
        label: "id",
        classification: "public" as const,
        extractor: { kind: "json_path" as const, path: "$.orderId" },
        identityRole: "continuation_identity" as const,
        generatedValueEligible: true,
      },
    ],
    continuation: "none" as const,
  },
  retrieval: { canonicalTargetFieldKey: "orderId", pathTemplate: "/orders/{orderId}" },
};

describe("prepared protected operation contracts", () => {
  it("keeps canonical field keys authoritative while aliases remain inert labels", () => {
    expect(operationContractFactsSchema.parse(facts).inputs[0]).toMatchObject({
      key: "orderId",
      aliases: ["Order ID"],
    });
    expect(
      operationContractFactsSchema.safeParse({
        ...facts,
        inputs: [{ ...facts.inputs[0], key: "Order ID" }],
      }).success,
    ).toBe(false);
  });

  it("requires all immutable commitments and typed value sources at reservation", () => {
    const reservation = {
      projectId: id("3"),
      environmentId: id("4"),
      missionId: id("5"),
      objectiveId: id("6"),
      agentSessionId: id("7"),
      publicOperationId: "retrieve-order-once",
      operationContractRevisionId: id("1"),
      operationContractRevisionDigest: hash("a"),
      runtimeInteractionCapabilityId: id("2"),
      targetCommitment: hash("b"),
      inputCommitment: hash("c"),
      outputCommitment: hash("d"),
      values: [
        {
          canonicalFieldKey: "orderId",
          targetReference: "context-control-00000000000000000000000000000000",
          presentationClass: "plain_text",
          source: {
            kind: "generated_safe",
            valueAssetId: id("8"),
          },
        },
      ],
      expectedOutputs: [{ key: "orderId", classification: "public" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(reservePreparedProtectedOperationSchema.safeParse(reservation).success).toBe(true);
    const { expiresAt: _deadline, ...kernelDeadline } = reservation;
    expect(reservePreparedProtectedOperationSchema.safeParse(kernelDeadline).success).toBe(true);
    expect(
      reservePreparedProtectedOperationSchema.safeParse({
        ...reservation,
        values: [{ ...reservation.values[0], source: { kind: "protected_reference" } }],
      }).success,
    ).toBe(false);
  });

  it("exposes one continuation reference without claim or grant construction", () => {
    const continuation = {
      continuationReference: id("9"),
      sourceOperationId: id("10"),
      resourceType: "order",
      canonicalIdentityReference: id("11"),
      readOnly: true,
      description: "Retrieve the created order",
      eligibleOperations: [],
    };
    expect(missionContinuationSchema.safeParse(continuation).success).toBe(true);
    expect(missionContinuationSchema.safeParse({ ...continuation, readOnly: false }).success).toBe(
      false,
    );
    expect(
      missionContinuationSchema.safeParse({
        ...continuation,
        consumerProtectedOperationId: id("12"),
      }).success,
    ).toBe(false);
  });
});
