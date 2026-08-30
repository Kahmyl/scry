import { describe, expect, it } from "vitest";

import {
  claimMissionOperationContinuationSchema,
  observedOperationContractSchema,
  reservePreparedProtectedOperationSchema,
} from "../src/index.js";

const id = (last: string) => `00000000-0000-4000-8000-${last.padStart(12, "0")}`;
const hash = (character: string) => character.repeat(64);

const contract = {
  id: id("1"),
  digest: hash("a"),
  praxisSessionId: id("2"),
  documentEpoch: 4,
  origin: "https://example.test",
  sourceKind: "public_document" as const,
  observationId: "observation-4",
  operation: {
    key: "retrieveOrder",
    label: "Retrieve order",
    method: "GET" as const,
    pathTemplate: "/orders/{orderId}",
    transports: ["fetch" as const],
    classification: "read_only" as const,
    activationControlReference: "context-control-11111111111111111111111111111111",
  },
  inputs: [
    {
      key: "orderId",
      label: "Order ID",
      aliases: ["Order ID"],
      required: true,
      classification: "generated_safe" as const,
      acceptedPresentations: ["plain_text" as const],
      controlReference: "context-control-00000000000000000000000000000000",
    },
  ],
  auth: { presentationClasses: [] },
  response: {
    statusClasses: [2],
    confirmedNotAppliedStatuses: [404],
    safeOutputKeys: ["orderId"],
    safeOutputs: [{ key: "orderId", label: "id", classification: "public" as const }],
    publicIdentityOutputPath: "$.orderId",
    continuation: "none" as const,
  },
  retrieval: { canonicalTargetFieldKey: "orderId", pathTemplate: "/orders/{orderId}" },
};

describe("prepared protected operation contracts", () => {
  it("keeps canonical field keys authoritative while aliases remain inert labels", () => {
    expect(observedOperationContractSchema.parse(contract).inputs[0]).toMatchObject({
      key: "orderId",
      aliases: ["Order ID"],
    });
    expect(
      observedOperationContractSchema.safeParse({
        ...contract,
        inputs: [{ ...contract.inputs[0], key: "Order ID" }],
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
      praxisSessionId: id("2"),
      publicOperationId: "retrieve-order-once",
      observedOperationContractId: id("1"),
      observedOperationContractDigest: hash("a"),
      documentEpoch: 4,
      targetCommitment: hash("b"),
      inputCommitment: hash("c"),
      outputCommitment: hash("d"),
      values: [
        {
          canonicalFieldKey: "orderId",
          targetReference: "context-control-00000000000000000000000000000000",
          presentationClass: "plain_text",
          source: { kind: "generated_safe", valueId: id("8") },
        },
      ],
      expectedOutputs: [{ key: "orderId", classification: "public" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(reservePreparedProtectedOperationSchema.safeParse(reservation).success).toBe(true);
    expect(
      reservePreparedProtectedOperationSchema.safeParse({
        ...reservation,
        values: [{ ...reservation.values[0], source: { kind: "protected_reference" } }],
      }).success,
    ).toBe(false);
  });

  it("allows generated output presentation only for exact read-only consumers", () => {
    const claim = {
      checkpointId: id("9"),
      consumerProtectedOperationId: id("10"),
      continuation: "read_only_retrieve",
      sourceOutputReference: "orderId",
      canonicalFieldKey: "orderId",
      targetReference: "path-order-id",
      presentationClass: "plain_text",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(claimMissionOperationContinuationSchema.safeParse(claim).success).toBe(true);
    expect(
      claimMissionOperationContinuationSchema.safeParse({
        ...claim,
        continuation: "reconcile",
      }).success,
    ).toBe(false);
  });
});
