import { Injectable } from "@nestjs/common";
import type { InteractionTargetIntent } from "@scry/contracts";
import { prepareExternalResourceDestructiveTarget } from "@scry/praxis";
import type { AuthoritativeExternalResourceObservation } from "@scry/praxis";
import type { Page } from "playwright";

import { ExternalResourceBindingRepository } from "../repositories/external-resource-binding.repository.js";
import { ExternalResourcePresentationAuthorityRepository } from "../repositories/external-resource-presentation-authority.repository.js";

@Injectable()
export class ExternalResourceDestructiveTargetPreparationService {
  constructor(
    private readonly bindings: ExternalResourceBindingRepository,
    private readonly authorities: ExternalResourcePresentationAuthorityRepository,
  ) {}

  async prepare(input: {
    page: Page;
    credentialId: string;
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
    action: InteractionTargetIntent;
    observeResources(input: {
      phase: "initial" | "pre_dispatch";
      resourceCollection: string;
      presentationIdentity: {
        semanticField: string;
        classification: "internal_non_secret";
      };
    }): Promise<AuthoritativeExternalResourceObservation>;
    allowedOrigins: string[];
  }) {
    const binding = await this.bindings.resolveActiveForCredential(input);
    const presentationContract = await this.authorities.resolveActive({
      projectId: input.projectId,
      environmentId: input.environmentId,
      provider: binding.provider,
      resourceKind: binding.resourceKind,
      resourceScope: binding.resourceScope,
      contractVersion: binding.identityContractVersion,
      action: input.action,
    });
    return prepareExternalResourceDestructiveTarget({
      page: input.page,
      binding,
      expectedOwnership: { projectId: input.projectId, environmentId: input.environmentId },
      presentationContract,
      observeResources: ({ phase, contract }) =>
        input.observeResources({
          phase,
          resourceCollection: contract.presentationObservation.resourceCollection,
          presentationIdentity: contract.presentationIdentity,
        }),
      allowedOrigins: input.allowedOrigins,
    });
  }
}
