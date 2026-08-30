import type { PraxisObservation } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { VitractObservedOperationContractProvider } from "../src/adaptive-sessions/vitract-observed-operation-contract.provider.js";

describe("registered Vitract observed operation contracts", () => {
  const provider = new VitractObservedOperationContractProvider();

  it("projects canonical create and exact GET retrieval only from current scoped controls", () => {
    const contracts = provider.project(
      "00000000-0000-4000-8000-000000000001",
      observation("https://preview-api.vitract.com/api/docs/partner-api#createPartnerOrder", [
        control("Run POST", "activate", "Create Order", "1"),
        control("Client ID", "enter_text", "Create Order", "2"),
        control("Client secret", "enter_text", "Create Order", "3"),
        control("Idempotency-Key", "enter_text", "Create Order", "4"),
        control("JSON body", "enter_text", "Create Order", "5"),
        control("Run", "activate", "Retrieve Order examples", "6"),
        control("Client ID", "enter_text", "Retrieve Order examples", "7"),
        control("Client secret", "enter_text", "Retrieve Order examples", "8"),
        control("orderId", "enter_text", "Retrieve Order examples", "9"),
      ]),
    );
    expect(contracts.map((contract) => contract.operation.key)).toEqual([
      "createOrder",
      "retrieveOrder",
    ]);
    expect(contracts[0]).toMatchObject({
      sourceKind: "runtime_observation",
      operation: { method: "POST", classification: "mutation" },
      response: {
        publicIdentityOutputPath: "$.data.id",
        continuation: "read_only_retrieve",
      },
      retrieval: { canonicalTargetFieldKey: "orderId" },
    });
    expect(contracts[1]).toMatchObject({
      operation: { method: "GET", classification: "read_only" },
      inputs: expect.arrayContaining([
        expect.objectContaining({ key: "orderId", aliases: ["Order ID"] }),
      ]),
    });
    expect(JSON.stringify(contracts)).not.toMatch(/credential.?value|secret.?value|plaintext/i);
  });

  it("projects issuance only from the exact application credential form", () => {
    const [contract] = provider.project(
      "00000000-0000-4000-8000-000000000001",
      observation("https://preview.vitract.com/partner/developer/applications/app-1/credentials", [
        control("Add credential", "activate", "form", "a", "form"),
        control("Name", "enter_text", "form", "b", "form"),
      ]),
    );
    expect(contract).toMatchObject({
      operation: {
        key: "issuePartnerCredential",
        method: "POST",
        pathTemplate: "/api/v1/partners/applications/{applicationId}/credentials",
      },
      response: {
        safeOutputKeys: ["credentialRecordId", "clientId", "clientSecret"],
      },
      resourceEffect: {
        provider: "vitract",
        resourceKind: "credential_record",
        resourceScope: "app-1",
        identityOutputKey: "credentialRecordId",
        correlationFieldKey: "credentialName",
      },
    });
  });

  it("returns no provider facts for lookalike origins or incomplete controls", () => {
    expect(
      provider.project(
        "00000000-0000-4000-8000-000000000001",
        observation("https://lookalike.test/api/docs/partner-api", [
          control("Run POST", "activate", "Create Order", "c"),
        ]),
      ),
    ).toEqual([]);
    expect(
      provider.project(
        "00000000-0000-4000-8000-000000000001",
        observation("https://preview-api.vitract.com/api/docs/partner-api", [
          control("Run POST", "activate", "Create Order", "d"),
        ]),
      ),
    ).toEqual([]);
  });
});

function control(
  name: string,
  capability: string,
  group: string,
  character: string,
  boundaryKind: "form" | "section" = "section",
) {
  return {
    reference: `context-control-${character.repeat(32)}`,
    role: capability === "enter_text" ? "textbox" : "button",
    name,
    group,
    capabilities: ["observe", capability],
    boundary: { kind: boundaryKind, name: group },
  };
}

function observation(url: string, controls: ReturnType<typeof control>[]) {
  return {
    documentEpoch: 3,
    url,
    semanticPageContext: { controls },
  } as unknown as PraxisObservation;
}
