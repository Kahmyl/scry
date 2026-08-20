import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type {
  AdaptiveSessionOperationInput,
  ExpectedEffect,
  MissionAuthoringIntent,
} from "@scry/contracts";

const resourceIdentitySchema = z
  .object({
    provider: z.string().min(1),
    resourceKind: z.string().min(1),
    resourceScope: z.string().min(1),
    identity: z.string().min(1),
    state: z.string().min(1),
  })
  .strict();

export const authoritativeResourceReconciliationSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("proven_applied"),
      reasonCode: z.string().min(1),
      resource: resourceIdentitySchema,
      outputState: z.enum(["usable", "not_applicable"]),
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      result: z.literal("proven_applied_output_unrecovered"),
      reasonCode: z.string().min(1),
      resource: resourceIdentitySchema,
      outputState: z.literal("unrecovered"),
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      result: z.literal("proven_not_applied"),
      reasonCode: z.string().min(1),
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      result: z.literal("still_unknown"),
      reasonCode: z.string().min(1),
      evidence: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);

export type UnknownOperationAuthority = {
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  flowDraftId: string;
  sessionId: string;
  operationId: string;
  action: AdaptiveSessionOperationInput["action"];
  authoringIntent?: MissionAuthoringIntent;
  preparationFacts?: ReadonlyArray<{
    intentId: string;
    actionKind: string;
    publicValue?: string;
    protectedReferenceId?: string;
    targetConcept?: string;
    targetPlaceholder?: string;
  }>;
  expectedEffect: ExpectedEffect;
  idempotencyKey: string;
  dispatchBoundary: string;
  dispatchIdentity: { operationCreatedAt: string };
  baseline: { url: string; documentEpoch: number; effectState: Record<string, unknown> } | null;
  localEvidence?: {
    mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
    acquisitionState: "not_started" | "running" | "complete" | "failed";
    persistenceState: "not_started" | "running" | "committed" | "failed" | "uncertain";
    requiredOutputReferences: string[];
    persistedReferences: Record<string, unknown>;
    activeBinding: {
      provider: string;
      resourceKind: string;
      resourceScope: string;
      canonicalExternalIdentity: string;
    } | null;
  } | null;
};

export type AuthoritativeResourceReconciliation = z.infer<
  typeof authoritativeResourceReconciliationSchema
>;

export type AuthoritativeReconciliationProvider = {
  id: string;
  supports: (authority: Readonly<UnknownOperationAuthority>) => boolean;
  observe: (
    authority: Readonly<UnknownOperationAuthority>,
  ) => Promise<AuthoritativeResourceReconciliation>;
};

@Injectable()
export class AdaptiveOperationReconciliationRegistry {
  private readonly providers = new Map<string, AuthoritativeReconciliationProvider>();

  private supporting(authority: UnknownOperationAuthority) {
    return [...this.providers.values()].filter((provider) =>
      provider.supports(Object.freeze(authority)),
    );
  }

  available(authority: UnknownOperationAuthority) {
    return this.supporting(authority).length === 1;
  }

  async reconcile(authority: UnknownOperationAuthority) {
    const supporting = this.supporting(authority);
    if (supporting.length !== 1) return null;
    const providerResult = authoritativeResourceReconciliationSchema.parse(
      await supporting[0]!.observe(Object.freeze(authority)),
    );
    if (providerResult.result !== "proven_applied_output_unrecovered") return providerResult;
    const local = authority.localEvidence;
    const binding = local?.activeBinding;
    const completeOutputs = local?.requiredOutputReferences.every((reference) =>
      Object.hasOwn(local.persistedReferences, reference),
    );
    if (
      local?.persistenceState !== "committed" ||
      !completeOutputs ||
      !binding ||
      binding.provider !== providerResult.resource.provider ||
      binding.resourceKind !== providerResult.resource.resourceKind ||
      binding.resourceScope !== providerResult.resource.resourceScope ||
      binding.canonicalExternalIdentity !== providerResult.resource.identity
    )
      return providerResult;
    return authoritativeResourceReconciliationSchema.parse({
      result: "proven_applied",
      reasonCode: "AUTHORITATIVE_RESOURCE_AND_LOCAL_OUTPUTS_PRESENT",
      resource: providerResult.resource,
      outputState: "usable",
      evidence: { ...providerResult.evidence, localPersistenceQualification: true },
    });
  }

  /** Server-owned adapter seam; callers cannot supply outcomes or evidence. */
  register(provider: AuthoritativeReconciliationProvider) {
    if (this.providers.has(provider.id))
      throw new Error("RECONCILIATION_PROVIDER_ALREADY_REGISTERED");
    this.providers.set(provider.id, provider);
    return () => this.providers.delete(provider.id);
  }
}
