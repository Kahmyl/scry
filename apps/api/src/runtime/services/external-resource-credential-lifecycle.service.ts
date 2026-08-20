import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { GroundingResult } from "@scry/praxis";
import { Database } from "../../infrastructure/index.js";
import { ExecutionKernelRepository } from "../repositories/execution-kernel.repository.js";

export type ExternalRevocationReconciliation =
  | {
      state: "confirmed_revoked";
      requestObserved: true;
      responseObserved: true;
      statusClass: string;
    }
  | {
      state: "confirmed_not_revoked";
      requestObserved: boolean;
      responseObserved: boolean;
      statusClass?: string;
    }
  | { state: "unknown"; requestObserved: boolean; responseObserved: boolean; statusClass?: string };

@Injectable()
export class ExternalResourceCredentialLifecycleService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ExecutionKernelRepository) private readonly kernel: ExecutionKernelRepository,
  ) {}

  async revoke(input: {
    sessionId: string;
    operationId: string;
    credentialId: string;
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
    target: GroundingResult;
    dispatch(): Promise<void>;
    reconcile(): Promise<ExternalRevocationReconciliation>;
  }) {
    const digest = createHash("sha256")
      .update(
        [
          "external-resource-revoke-v1",
          input.projectId,
          input.environmentId,
          input.provider,
          input.resourceKind,
          input.resourceScope,
          input.credentialId,
        ].join("\0"),
      )
      .digest("hex");
    const claim = await this.kernel.claimMutation(input.sessionId, {
      operationId: input.operationId,
      mutationKind: "one_time",
      programDigest: digest,
      inputSchemaDigest: digest,
      inputDigest: digest,
    });
    if (claim.state !== "planned") throw new Error("EXTERNAL_REVOKE_ALREADY_DISPATCHED");
    await input.target.revalidate();
    await this.transition(input, claim.fencingToken, "planned", "dispatch_authorized");
    await this.transition(input, claim.fencingToken, "dispatch_authorized", "dispatching");
    try {
      await input.dispatch();
      await this.transition(input, claim.fencingToken, "dispatching", "dispatched");
      const reconciliation = await input.reconcile();
      if (reconciliation.state !== "confirmed_revoked") {
        await this.transition(
          input,
          claim.fencingToken,
          "dispatched",
          reconciliation.state === "confirmed_not_revoked"
            ? "reconciled_not_applied"
            : "outcome_unknown",
        );
        return { outcome: reconciliation.state, dispatchCount: 1 as const, reconciliation };
      }
      await this.settleConfirmed(input);
      await this.transition(input, claim.fencingToken, "dispatched", "reconciled_succeeded");
      return { outcome: "confirmed_revoked" as const, dispatchCount: 1 as const, reconciliation };
    } catch (error) {
      await this.kernel
        .transitionMutation(input.sessionId, {
          operationId: input.operationId,
          fencingToken: claim.fencingToken,
          expected: "dispatching",
          next: "outcome_unknown",
        })
        .catch(() => false);
      throw error;
    }
  }

  async reconcileUnknown(input: {
    sessionId: string;
    operationId: string;
    credentialId: string;
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
    result: "confirmed_revoked" | "confirmed_not_applied" | "unknown";
  }) {
    const claim = await this.kernel.claimMutation(input.sessionId, {
      operationId: input.operationId,
      mutationKind: "one_time",
      programDigest: createHash("sha256")
        .update(
          [
            "external-resource-revoke-v1",
            input.projectId,
            input.environmentId,
            input.provider,
            input.resourceKind,
            input.resourceScope,
            input.credentialId,
          ].join("\0"),
        )
        .digest("hex"),
      inputSchemaDigest: createHash("sha256")
        .update(
          [
            "external-resource-revoke-v1",
            input.projectId,
            input.environmentId,
            input.provider,
            input.resourceKind,
            input.resourceScope,
            input.credentialId,
          ].join("\0"),
        )
        .digest("hex"),
      inputDigest: createHash("sha256")
        .update(
          [
            "external-resource-revoke-v1",
            input.projectId,
            input.environmentId,
            input.provider,
            input.resourceKind,
            input.resourceScope,
            input.credentialId,
          ].join("\0"),
        )
        .digest("hex"),
    });
    if (claim.state !== "outcome_unknown") throw new Error("EXTERNAL_REVOKE_NOT_RECOVERABLE");
    if (input.result === "unknown") return { outcome: "unknown" as const };
    if (input.result === "confirmed_not_applied") {
      await this.transition(input, claim.fencingToken, "outcome_unknown", "reconciled_not_applied");
      return { outcome: "confirmed_not_applied" as const };
    }
    await this.settleConfirmed(input);
    await this.transition(input, claim.fencingToken, "outcome_unknown", "reconciled_succeeded");
    return { outcome: "confirmed_revoked" as const };
  }

  private async transition(
    input: { sessionId: string; operationId: string },
    fencingToken: number,
    expected: string,
    next: string,
  ) {
    if (
      !(await this.kernel.transitionMutation(input.sessionId, {
        operationId: input.operationId,
        fencingToken,
        expected,
        next,
      }))
    )
      throw new Error("EXTERNAL_REVOKE_MUTATION_FENCE_LOST");
  }

  private settleConfirmed(input: {
    credentialId: string;
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
  }) {
    return this.database.transaction(async (client) => {
      const owned = await client.query(
        `SELECT 1 FROM project_credentials credential
        JOIN external_resource_bindings binding ON binding.source_protected_operation_id=credential.origin_protected_operation_id AND binding.project_id=credential.project_id
        WHERE credential.id=$1 AND credential.project_id=$2 AND credential.security_status IN ('active','compromised')
          AND credential.deleted_at IS NULL AND binding.environment_id=$3 AND binding.provider=$4
          AND binding.resource_kind=$5 AND binding.resource_scope=$6 AND binding.lifecycle_state='active'
          AND binding.required_for_destructive_lifecycle=true FOR UPDATE OF credential,binding`,
        [
          input.credentialId,
          input.projectId,
          input.environmentId,
          input.provider,
          input.resourceKind,
          input.resourceScope,
        ],
      );
      if (owned.rowCount !== 1) throw new Error("EXTERNAL_REVOKE_BINDING_NOT_ACTIVE");
      await client.query(
        `UPDATE project_credentials SET security_status='revoked',updated_at=now()
        WHERE id=$1 AND project_id=$2 AND security_status IN ('active','compromised')`,
        [input.credentialId, input.projectId],
      );
      const settled = await client.query<{ credentialStatus: string; bindingState: string }>(
        `SELECT credential.security_status AS "credentialStatus",binding.lifecycle_state AS "bindingState"
        FROM project_credentials credential JOIN external_resource_bindings binding
          ON binding.source_protected_operation_id=credential.origin_protected_operation_id AND binding.project_id=credential.project_id
        WHERE credential.id=$1 AND credential.project_id=$2`,
        [input.credentialId, input.projectId],
      );
      if (
        settled.rowCount !== 1 ||
        settled.rows[0]!.credentialStatus !== "revoked" ||
        settled.rows[0]!.bindingState !== "invalidated"
      )
        throw new Error("EXTERNAL_REVOKE_LIFECYCLE_SETTLEMENT_FAILED");
    });
  }
}
