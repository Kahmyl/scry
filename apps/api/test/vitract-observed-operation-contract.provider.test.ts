import type { PraxisObservation } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { VitractObservedOperationContractProvider } from "../src/adaptive-sessions/vitract-observed-operation-contract.provider.js";
import { OperationContractProviderRegistry } from "../src/adaptive-sessions/operation-contract.registry.js";

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
    expect(contracts.map((contract) => contract.facts.operation.key)).toEqual([
      "createOrder",
      "retrieveOrder",
    ]);
    expect(contracts[0]).toMatchObject({
      facts: {
        operation: { method: "POST", semantics: { dispatch: "mutation" } },
        response: {
          outputs: [
            expect.objectContaining({
              key: "orderId",
              extractor: { kind: "json_path", path: "$.data.id" },
              identityRole: "resource_identity",
            }),
          ],
          continuation: "read_only_retrieve",
        },
        retrieval: { canonicalTargetFieldKey: "orderId" },
      },
      provenance: { sourceKind: "runtime_observation" },
    });
    expect(contracts[1]).toMatchObject({
      facts: {
        operation: { method: "GET", semantics: { dispatch: "read_only" } },
        inputs: expect.arrayContaining([
          expect.objectContaining({ key: "orderId", aliases: ["Order ID"] }),
        ]),
      },
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
      facts: {
        operation: {
          key: "issuePartnerCredential",
          method: "POST",
          pathTemplate: "/api/v1/partners/applications/{applicationId}/credentials",
        },
        response: {
          outputs: expect.arrayContaining([
            expect.objectContaining({ key: "credentialRecordId" }),
            expect.objectContaining({ key: "clientId" }),
            expect.objectContaining({ key: "clientSecret" }),
          ]),
        },
        resourceEffect: {
          provider: "vitract",
          resourceKind: "credential_record",
          resourceScope: "app-1",
          identityOutputKey: "credentialRecordId",
          correlationFieldKey: "credentialName",
        },
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

  it("rejects conflicting semantic revisions from sibling providers", () => {
    const evidence = observation(
      "https://preview.vitract.com/partner/developer/applications/app-1/credentials",
      [
        control("Add credential", "activate", "form", "a", "form"),
        control("Name", "enter_text", "form", "b", "form"),
      ],
    );
    const [canonical] = provider.project("00000000-0000-4000-8000-000000000001", evidence);
    const conflicting = structuredClone(canonical!);
    conflicting.facts.operation.label = "Conflicting operation meaning";
    const registry = new OperationContractProviderRegistry([
      {
        project: () => [conflicting],
      },
    ]);
    expect(() =>
      registry.project("00000000-0000-4000-8000-000000000001", evidence, [canonical!]),
    ).toThrow("Conflict Exception");
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
