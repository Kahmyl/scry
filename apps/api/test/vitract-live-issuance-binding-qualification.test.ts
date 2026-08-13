import { describe, expect, it, vi } from "vitest";

import {
  preparedSingleIssuanceIntent,
  qualifySingleLiveIssuance,
  type LiveQualificationProductionAdapters,
} from "../scripts/vitract-live-issuance-binding-qualification.js";

describe("Vitract live issuance qualification static gate", () => {
  const authorizationId = "11111111-1111-4111-8111-111111111111";
  const intent = () => preparedSingleIssuanceIntent(authorizationId);

  it("contains exactly one one-time issuance and one explicit canonical binding", () => {
    const value = intent();
    expect(value.action.kind).toBe("acquire_protected_outputs");
    if (value.action.kind !== "acquire_protected_outputs") throw new Error("unexpected intent");
    expect(value.action.mutation.kind).toBe("one_time");
    expect(value.action.externalResourceBindings).toEqual([expect.objectContaining({
      status: "active", identityReference: "credentialRecordIdentity",
      provider: "vitract", resourceKind: "credential_record", identitySource: "response",
    })]);
    expect(value.action.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "credentialRecordIdentity", classification: "public" }),
      expect.objectContaining({ reference: "credentialClientId", classification: "protected" }),
      expect.objectContaining({ reference: "credentialClientSecret", classification: "protected" }),
    ]));
  });

  it("rejects the inert placeholder authorization", () => {
    expect(() => preparedSingleIssuanceIntent("00000000-0000-4000-8000-000000000000"))
      .toThrow("LIVE_ISSUANCE_AUTHORIZATION_INVALID");
  });

  it("uses one production issuance seam and prepares, but never dispatches, the lifecycle target", async () => {
    const production: LiveQualificationProductionAdapters = {
      executeSingleIssuance: vi.fn(async () => ({
        operationId: "operation-opaque",
        generatedReferences: [
          { reference: "credentialRecordIdentity" as const, classification: "public" as const, opaqueReferenceId: "reference-identity" },
          { reference: "credentialClientId" as const, classification: "protected" as const, opaqueReferenceId: "reference-client" },
          { reference: "credentialClientSecret" as const, classification: "protected" as const, opaqueReferenceId: "reference-secret" },
        ],
      })),
      readBinding: vi.fn(async () => ({
        status: "active", provider: "vitract", resourceKind: "credential_record",
        resourceScope: "vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a",
        identityContractVersion: 1, sourceProtectedOperationId: "operation-opaque",
      } as const)),
      readPresentationAuthority: vi.fn(async () => ({
        classification: "internal_non_secret", permittedPurpose: "browser_presentation_identity",
        contractVersion: 1, status: "active",
      } as const)),
      prepareTargetWithoutDispatch: vi.fn(async () => ({
        providerRevalidated: true, presentationIdentityValidated: true,
      } as const)),
    };
    await expect(qualifySingleLiveIssuance(authorizationId, production)).resolves.toEqual({
      issuanceDispatchCount: 1, destructiveDispatchCount: 0, atomicBindingReadback: true,
      trustedPresentationAuthorityReadback: true, targetPreparedWithoutDispatch: true,
    });
    expect(production.executeSingleIssuance).toHaveBeenCalledOnce();
    expect(production.prepareTargetWithoutDispatch).toHaveBeenCalledOnce();
  });

  it("contains no destructive lifecycle, rotation, deletion, second issuance, or unsafe selector path", () => {
    const serialized = JSON.stringify(intent());
    expect(serialized).not.toMatch(/revoke|rotate|delete|nth-child|set.?difference/i);
    expect(serialized.match(/acquire_protected_outputs/g)).toHaveLength(1);
  });
});
