import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  executionPolicySchema,
  externalResourcePresentationContractSchema,
  type ExternalResourcePresentationContract,
  type InteractionTargetIntent,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

@Injectable()
export class ExternalResourcePresentationAuthorityRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async resolveActive(input: {
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
    contractVersion: number;
    action: InteractionTargetIntent;
  }): Promise<ExternalResourcePresentationContract> {
    const result = await this.database.query<{ policy: unknown }>(
      `SELECT policy FROM environments WHERE id=$1 AND project_id=$2`,
      [input.environmentId, input.projectId],
    );
    if (result.rowCount !== 1)
      throw new ConflictException({ code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" });
    const policy = executionPolicySchema.parse(result.rows[0]!.policy);
    const authorities = policy.externalResourcePresentationAuthorities ?? [];
    const matching = authorities.filter((authority) =>
      authority.provider === input.provider &&
      authority.resourceKind === input.resourceKind &&
      authority.resourceScope === input.resourceScope &&
      authority.contractVersion === input.contractVersion &&
      authority.status === "active",
    );
    if (matching.length !== 1)
      throw new ConflictException({ code: "EXTERNAL_PRESENTATION_AUTHORITY_UNAVAILABLE" });
    const authority = matching[0]!;
    const newer = authorities.some((candidate) =>
      candidate.provider === authority.provider &&
      candidate.resourceKind === authority.resourceKind &&
      candidate.resourceScope === authority.resourceScope &&
      candidate.contractVersion === authority.contractVersion &&
      candidate.revision > authority.revision,
    );
    if (newer)
      throw new ConflictException({ code: "EXTERNAL_PRESENTATION_AUTHORITY_STALE" });
    return externalResourcePresentationContractSchema.parse({
      canonicalIdentity: { source: "external_resource_binding" },
      resource: {
        provider: authority.provider,
        kind: authority.resourceKind,
        scope: authority.resourceScope,
      },
      presentationObservation: {
        source: "authoritative_read_only_resource_observation",
        resourceCollection: authority.resourceCollection,
      },
      presentationIdentity: {
        semanticField: authority.semanticField,
        classification: authority.classification,
        stability: "current_projection",
      },
      browserBoundary: { kind: authority.browserBoundaryKind },
      action: input.action,
    });
  }
}
