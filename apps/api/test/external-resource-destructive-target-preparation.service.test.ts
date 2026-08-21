import { describe, expect, it, vi } from "vitest";

import { ExternalResourceDestructiveTargetPreparationService } from "../src/runtime/services/external-resource-destructive-target-preparation.service.js";

describe("external resource destructive preparation authority composition", () => {
  it("resolves binding and trusted authority before invoking any observation", async () => {
    const binding = {
      sourceProtectedOperationId: "operation-a",
      projectId: "project-a",
      environmentId: "environment-a",
      provider: "provider",
      resourceKind: "credential",
      resourceScope: "application-a",
      externalIdentity: "canonical-a",
      identityContractVersion: 1,
    };
    const bindings = { resolveActiveForCredential: vi.fn().mockResolvedValue(binding) };
    const authorities = {
      resolveActive: vi.fn().mockRejectedValue({
        response: { code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" },
      }),
    };
    const observeResources = vi.fn();
    const service = new ExternalResourceDestructiveTargetPreparationService(
      bindings as never,
      authorities as never,
    );
    await expect(
      service.prepare({
        page: {} as never,
        credentialId: "credential-a",
        projectId: "project-a",
        environmentId: "environment-a",
        provider: "provider",
        resourceKind: "credential",
        resourceScope: "application-a",
        allowedOrigins: [],
        observeResources,
        action: {
          concept: "revoke",
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Revoke"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "destructive",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
      }),
    ).rejects.toMatchObject({ response: { code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" } });
    expect(bindings.resolveActiveForCredential).toHaveBeenCalledOnce();
    expect(authorities.resolveActive).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "provider",
        resourceKind: "credential",
        resourceScope: "application-a",
        contractVersion: 1,
      }),
    );
    expect(observeResources).not.toHaveBeenCalled();
  });
});
