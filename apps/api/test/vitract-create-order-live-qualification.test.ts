import { describe, expect, it } from "vitest";
import { missionAuthoringIntentSchema } from "@scry/contracts";
import {
  createIntents,
  selectAuthoritativeCredentialPair,
  type CredentialPairCandidate,
} from "../scripts/vitract-create-order-live-qualification.js";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("Vitract Create production qualification composition", () => {
  it("authors one typed Create mutation with protected structured sources and no plaintext", () => {
    const intents = createIntents(
      {
        missionId: id("1"),
        objectiveId: id("2"),
        flowDraftId: id("3"),
        agentSessionId: id("4"),
        authorizationId: id("5"),
        entryUrl: "https://preview-api.vitract.com/api/docs/partner-api",
        allowedOrigins: ["https://preview-api.vitract.com"],
        credentialReferenceIds: [id("6"), id("7")],
        policy: {},
      },
      "run",
    );
    intents.preparation.forEach((intent) =>
      expect(() => missionAuthoringIntentSchema.parse(intent)).not.toThrow(),
    );
    expect(() => missionAuthoringIntentSchema.parse(intents.operation)).not.toThrow();
    expect(intents.preparation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({ kind: "set_checked", checked: true }),
          expectedEffect: expect.objectContaining({ kind: "target_state", checked: true }),
        }),
      ]),
    );
    expect(intents.operation.action).toMatchObject({
      kind: "acquire_protected_outputs",
      request: {
        method: "POST",
        pathTemplate: "/api/v1/partner-api/orders",
        transports: ["fetch"],
      },
      syntheticProtectedInputs: [
        { semantic: "provider_idempotency_key", generatorContract: "opaque_operation_token" },
        { semantic: "nested_client_payload", generatorContract: "nested_client_order_json" },
      ],
    });
    const serialized = JSON.stringify(intents);
    expect(serialized).not.toMatch(/@example\.test|firstName|lastName|addressLineOne|postalCode/);
    expect(serialized.match(/"method":"POST"/g)).toHaveLength(1);
  });

  const authority = {
    projectId: "project-a",
    environmentId: "environment-test",
    providerOrigin: "https://preview-api.vitract.com",
    credentialIssuanceOperationId: "issuance-a",
  };
  const candidate = (
    overrides: Partial<CredentialPairCandidate> = {},
  ): CredentialPairCandidate => ({
    clientIdReferenceId: "client-id-a",
    clientSecretReferenceId: "client-secret-a",
    projectId: authority.projectId,
    environmentId: authority.environmentId,
    issuanceOperationId: "issuance-a",
    providerOrigin: authority.providerOrigin,
    listRequestMethod: "GET",
    listOperationCompleted: true,
    listPersistenceCommitted: true,
    issuanceCompleted: true,
    issuancePersistenceCommitted: true,
    issuanceApplied: true,
    clientIdRole: "partner_api_client_id",
    clientSecretRole: "partner_api_client_secret",
    pairActive: true,
    pairEnvironmentBound: true,
    pairAtomicallyPersisted: true,
    ...overrides,
  });

  it("selects one exact semantically and atomically proven Partner API pair", () => {
    expect(selectAuthoritativeCredentialPair([candidate()], authority)).toEqual([
      "client-id-a",
      "client-secret-a",
    ]);
  });

  it.each([
    ["login roles", { clientIdRole: "login_email", clientSecretRole: "login_password" }],
    ["mixed issuance", { pairAtomicallyPersisted: false }],
    ["different environment", { environmentId: "environment-live" }],
    ["different project/application", { projectId: "project-b" }],
    ["different provider authority", { providerOrigin: "https://other.example" }],
    ["different provider application issuance", { issuanceOperationId: "issuance-other" }],
    ["revoked pair", { pairActive: false }],
    ["unbound pair", { pairEnvironmentBound: false }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => selectAuthoritativeCredentialPair([candidate(overrides)], authority)).toThrow(
      "CREATE_CREDENTIAL_PAIR_UNAVAILABLE",
    );
  });

  it("deduplicates historical successful List evidence for the same canonical pair", () => {
    expect(selectAuthoritativeCredentialPair([candidate(), candidate()], authority)).toEqual([
      "client-id-a",
      "client-secret-a",
    ]);
  });

  it("fails closed when different eligible active pairs remain", () => {
    expect(() =>
      selectAuthoritativeCredentialPair(
        [
          candidate(),
          candidate({
            clientIdReferenceId: "client-id-b",
            clientSecretReferenceId: "client-secret-b",
          }),
        ],
        authority,
      ),
    ).toThrow("CREATE_CREDENTIAL_PAIR_AMBIGUOUS");
  });
});
