import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { AdaptiveSessionOperationInput, ExpectedEffect, MissionAuthoringIntent } from "@scry/contracts";

const resourceIdentitySchema = z.object({
  provider: z.string().min(1),
  resourceKind: z.string().min(1),
  resourceScope: z.string().min(1),
  identity: z.string().min(1),
  state: z.string().min(1),
}).strict();

export const authoritativeResourceReconciliationSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("proven_applied"), reasonCode: z.string().min(1),
    resource: resourceIdentitySchema, outputState: z.enum(["usable", "not_applicable"]),
    evidence: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    result: z.literal("proven_applied_output_unrecovered"), reasonCode: z.string().min(1),
    resource: resourceIdentitySchema, outputState: z.literal("unrecovered"),
    evidence: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    result: z.literal("proven_not_applied"), reasonCode: z.string().min(1),
    evidence: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    result: z.literal("still_unknown"), reasonCode: z.string().min(1),
    evidence: z.record(z.string(), z.unknown()),
  }).strict(),
]);

export type UnknownOperationAuthority = {
  projectId: string; environmentId: string; missionId: string; objectiveId: string;
  flowDraftId: string; sessionId: string; operationId: string;
  action: AdaptiveSessionOperationInput["action"];
  authoringIntent?: MissionAuthoringIntent;
  preparationFacts?: ReadonlyArray<{
    intentId: string; actionKind: string; publicValue?: string;
    protectedReferenceId?: string; targetConcept?: string; targetPlaceholder?: string;
  }>;
  expectedEffect: ExpectedEffect; idempotencyKey: string; dispatchBoundary: string;
  dispatchIdentity: { operationCreatedAt: string };
  baseline: { url: string; documentEpoch: number; effectState: Record<string, unknown> } | null;
};

export type AuthoritativeResourceReconciliation = z.infer<typeof authoritativeResourceReconciliationSchema>;

export type AuthoritativeReconciliationProvider = {
  id: string;
  supports: (authority: Readonly<UnknownOperationAuthority>) => boolean;
  observe: (authority: Readonly<UnknownOperationAuthority>) => Promise<AuthoritativeResourceReconciliation>;
};

@Injectable()
export class AdaptiveOperationReconciliationRegistry {
  private readonly providers = new Map<string, AuthoritativeReconciliationProvider>();

  private supporting(authority: UnknownOperationAuthority) {
    return [...this.providers.values()].filter((provider) => provider.supports(Object.freeze(authority)));
  }

  available(authority: UnknownOperationAuthority) {
    return this.supporting(authority).length === 1;
  }

  async reconcile(authority: UnknownOperationAuthority) {
    const supporting = this.supporting(authority);
    if (supporting.length !== 1) return null;
    return authoritativeResourceReconciliationSchema.parse(
      await supporting[0]!.observe(Object.freeze(authority)),
    );
  }

  /** Server-owned adapter seam; callers cannot supply outcomes or evidence. */
  register(provider: AuthoritativeReconciliationProvider) {
    if (this.providers.has(provider.id)) throw new Error("RECONCILIATION_PROVIDER_ALREADY_REGISTERED");
    this.providers.set(provider.id, provider);
    return () => this.providers.delete(provider.id);
  }
}
