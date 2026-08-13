import type { InteractionTargetIntent } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { ExternalResourcePresentationAuthorityRepository } from "../src/runtime/repositories/external-resource-presentation-authority.repository.js";

const action = {
  concept: "revoke credential", requiredCapabilities: ["focusable", "pointer_activatable"],
  preferredEvidence: { roles: ["button"], names: ["Revoke"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
  scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: "destructive",
  confidence: { requiredFamilies: [] }, matching: "exact",
} satisfies InteractionTargetIntent;
const basePolicy = {
  allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
  allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1,
};
const authority = {
  provider: "provider", resourceKind: "credential", resourceScope: "application-a",
  resourceCollection: "application_credentials", semanticField: "label",
  classification: "internal_non_secret", permittedPurpose: "browser_presentation_identity",
  browserBoundaryKind: "row", contractVersion: 1, revision: 1, status: "active",
} as const;
const input = {
  projectId: "project-a", environmentId: "environment-a", provider: "provider",
  resourceKind: "credential", resourceScope: "application-a", contractVersion: 1, action,
};

function repository(authorities: unknown[], rowCount = 1) {
  const database = { query: async () => ({ rowCount, rows: rowCount ? [{
    policy: { ...basePolicy, externalResourcePresentationAuthorities: authorities },
  }] : [] }) };
  return new ExternalResourcePresentationAuthorityRepository(database as never);
}

describe("trusted external resource presentation authority", () => {
  it("A/O/P: resolves a scoped internal-only field without serializing a value", async () => {
    const contract = await repository([authority]).resolveActive(input);
    expect(contract).toMatchObject({
      resource: { provider: "provider", kind: "credential", scope: "application-a" },
      presentationIdentity: { semanticField: "label", classification: "internal_non_secret" },
    });
    expect(JSON.stringify(contract)).not.toContain("canonical-a");
    expect(JSON.stringify(contract)).not.toContain("Qualification credential");
  });

  it.each([
    ["B no authority", [], input],
    ["D wrong provider", [{ ...authority, provider: "other" }], input],
    ["E wrong resource kind", [{ ...authority, resourceKind: "other" }], input],
    ["F wrong scope", [{ ...authority, resourceScope: "other" }], input],
    ["H revoked", [{ ...authority, status: "revoked" }], input],
    ["T contract version mismatch", [authority], { ...input, contractVersion: 2 }],
  ] as const)("%s fails closed", async (_label, authorities, candidate) => {
    await expect(repository([...authorities]).resolveActive(candidate)).rejects.toMatchObject({
      response: { code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" },
    });
  });

  it("G rejects a wrong project/environment because no owned row resolves", async () => {
    await expect(repository([authority], 0).resolveActive({ ...input, projectId: "other" }))
      .rejects.toMatchObject({ response: { code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" } });
  });

  it("H/R rejects an active revision when a newer revision exists", async () => {
    await expect(repository([authority, { ...authority, revision: 2, status: "revoked" }]).resolveActive(input))
      .rejects.toMatchObject({ response: { code: "EXTERNAL_PRESENTATION_AUTHORITY_STALE" } });
  });

  it("I/S resolves only the declared semantic field and never falls back", async () => {
    const harnessClaim = { ...input, semanticField: "label" };
    const contract = await repository([{ ...authority, semanticField: "approvedName" }])
      .resolveActive(harnessClaim);
    expect(contract.presentationIdentity.semanticField).toBe("approvedName");
    expect(contract.presentationIdentity.semanticField).not.toBe("label");
  });

  it("resolves the sole active client ID revision and rejects a superseded label revision", async () => {
    const clientIdAuthority = { ...authority, semanticField: "clientId", revision: 2 } as const;
    const contract = await repository([
      { ...authority, status: "revoked" },
      clientIdAuthority,
    ]).resolveActive(input);
    expect(contract.presentationIdentity).toMatchObject({
      semanticField: "clientId",
      classification: "internal_non_secret",
    });
  });

  it.each(["clientId", "secretSuffix", "createdAt", "status"])(
    "K-N requires explicit authority even for candidate field %s",
    async (semanticField) => {
      await expect(repository([authority]).resolveActive(input)).resolves.toMatchObject({
        presentationIdentity: { semanticField: "label" },
      });
      expect(semanticField).not.toBe("label");
    },
  );
});
