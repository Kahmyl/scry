import { Injectable } from "@nestjs/common";
import type { AdaptiveSessionOperationInput, ExpectedEffect } from "@scry/contracts";

export type UnknownOperationAuthority = {
  projectId: string; environmentId: string; missionId: string; objectiveId: string;
  flowDraftId: string; sessionId: string; operationId: string;
  action: AdaptiveSessionOperationInput["action"];
  expectedEffect: ExpectedEffect; idempotencyKey: string; dispatchBoundary: string;
  dispatchIdentity: { operationCreatedAt: string };
  baseline: { url: string; documentEpoch: number; effectState: Record<string, unknown> } | null;
};

export type AuthoritativeResourceReconciliation = {
  result: "proven_applied" | "proven_not_applied" | "still_unknown";
  reasonCode: string;
  evidence: Record<string, unknown>;
};

export type AuthoritativeReconciliationProvider = {
  id: string;
  supports: (authority: Readonly<UnknownOperationAuthority>) => boolean;
  observe: (authority: Readonly<UnknownOperationAuthority>) => Promise<AuthoritativeResourceReconciliation>;
};

@Injectable()
export class AdaptiveOperationReconciliationRegistry {
  private readonly providers = new Map<string, AuthoritativeReconciliationProvider>();

  private supporting(authority: UnknownOperationAuthority) {
    if (authority.expectedEffect.type !== "network_outcome") return [];
    return [...this.providers.values()].filter((provider) => provider.supports(Object.freeze(authority)));
  }

  available(authority: UnknownOperationAuthority) {
    return this.supporting(authority).length === 1;
  }

  async reconcile(authority: UnknownOperationAuthority) {
    const supporting = this.supporting(authority);
    if (supporting.length !== 1) return null;
    return supporting[0]!.observe(Object.freeze(authority));
  }

  /** Server-owned adapter seam; callers cannot supply outcomes or evidence. */
  register(provider: AuthoritativeReconciliationProvider) {
    if (this.providers.has(provider.id)) throw new Error("RECONCILIATION_PROVIDER_ALREADY_REGISTERED");
    this.providers.set(provider.id, provider);
    return () => this.providers.delete(provider.id);
  }
}
