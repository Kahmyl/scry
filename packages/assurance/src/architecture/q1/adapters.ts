import {
  canTransitionProtectedOperation,
  objectiveStatusSchema,
  protectedOperationStateSchema,
  runStateSchema,
} from "@scry/contracts";

import { createReferenceState, freezeSnapshot } from "./state.js";
import type { MutationTruth, Q1Snapshot } from "./types.js";

export class PureReferenceAdapter {
  acquire(): Q1Snapshot {
    return createReferenceState();
  }
}

export class ContractHelperAdapter {
  exercise() {
    const protectedStates = protectedOperationStateSchema.options;
    let checkedTransitions = 0;
    for (const from of protectedStates) {
      for (const to of protectedStates) {
        canTransitionProtectedOperation(from, to);
        checkedTransitions += 1;
      }
    }
    return {
      adapter: "existing_contract_helper",
      checks:
        checkedTransitions + runStateSchema.options.length + objectiveStatusSchema.options.length,
      protectedStates: protectedStates.length,
      runStates: runStateSchema.options.length,
      objectiveStates: objectiveStatusSchema.options.length,
    } as const;
  }
}

export type Q1Queryable = {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

export type RepositorySnapshotIdentity = {
  missionId: string;
  objectiveId: string;
  runId?: string;
  praxisSessionId?: string;
  operationId?: string;
};

export class PostgresQ1Adapter {
  constructor(private readonly database: Q1Queryable) {}

  async acquire(identity: RepositorySnapshotIdentity): Promise<Q1Snapshot> {
    const base = structuredClone(createReferenceState()) as Mutable<Q1Snapshot>;
    const objective = await this.database.query<{
      missionId: string;
      projectId: string;
      objectiveId: string;
      objectiveState: string;
      conclusion: string | null;
      acceptedEvidence: boolean;
      missionState: string;
    }>(
      `SELECT objective.mission_id::text AS "missionId",mission.project_id::text AS "projectId",
              objective.id::text AS "objectiveId",objective.status AS "objectiveState",
              objective.conclusion,mission.status AS "missionState",
              EXISTS(SELECT 1 FROM accepted_evidence evidence
                WHERE evidence.objective_id=objective.id
                  AND evidence.superseded_at IS NULL AND evidence.invalidated_at IS NULL) AS "acceptedEvidence"
         FROM mission_objectives objective JOIN missions mission ON mission.id=objective.mission_id
        WHERE objective.mission_id=$1 AND objective.id=$2`,
      [identity.missionId, identity.objectiveId],
    );
    const durableObjective = objective.rows[0];
    if (!durableObjective) throw new Error("Q1_REPOSITORY_OBJECTIVE_NOT_FOUND");
    base.scope.missionId = durableObjective.missionId;
    base.scope.projectId = durableObjective.projectId;
    base.scope.objectiveId = durableObjective.objectiveId;
    base.mission.state = durableObjective.missionState;
    base.objective.state = objectiveStatusSchema.parse(durableObjective.objectiveState);
    base.objective.conclusion = durableObjective.conclusion;
    base.objective.acceptedEvidence = durableObjective.acceptedEvidence;

    if (identity.runId) {
      const run = await this.database.query<{
        runId: string;
        projectId: string;
        environmentId: string;
        agentSessionId: string;
        runState: string;
        resultClassification: string | null;
        attemptStates: string[];
        attemptHistory: Array<{
          attemptId: string;
          attemptNumber: number;
          state: string;
          claimToken: string | null;
        }>;
      }>(
        `SELECT run.id::text AS "runId",run.project_id::text AS "projectId",
                run.environment_id::text AS "environmentId",
                run.agent_session_id::text AS "agentSessionId",run.state AS "runState",
                run.result_classification AS "resultClassification",
                COALESCE(array_agg(attempt.state ORDER BY attempt.attempt_number)
                  FILTER (WHERE attempt.id IS NOT NULL),'{}') AS "attemptStates",
                COALESCE(jsonb_agg(jsonb_build_object(
                  'attemptId',attempt.id::text,'attemptNumber',attempt.attempt_number,
                  'state',attempt.state,'claimToken',attempt.claim_token::text
                ) ORDER BY attempt.attempt_number) FILTER (WHERE attempt.id IS NOT NULL),'[]'::jsonb)
                  AS "attemptHistory"
           FROM runs run LEFT JOIN attempts attempt ON attempt.run_id=run.id
          WHERE run.id=$1 AND run.mission_id=$2 AND run.objective_id=$3 GROUP BY run.id`,
        [identity.runId, identity.missionId, identity.objectiveId],
      );
      const durableRun = run.rows[0];
      if (!durableRun) throw new Error("Q1_REPOSITORY_RUN_NOT_FOUND");
      base.scope.runId = durableRun.runId;
      base.scope.projectId = durableRun.projectId;
      base.scope.environmentId = durableRun.environmentId;
      base.scope.agentSessionId = durableRun.agentSessionId;
      base.run.state = runStateSchema.parse(durableRun.runState);
      base.run.resultClassification = durableRun.resultClassification;
      base.run.attemptStates = durableRun.attemptStates;
      base.run.attemptHistory = durableRun.attemptHistory;
      base.run.attemptHistoryPreserved =
        durableRun.attemptHistory.length === durableRun.attemptStates.length &&
        new Set(durableRun.attemptHistory.map(({ attemptId }) => attemptId)).size ===
          durableRun.attemptHistory.length;
      base.run.operationMutable = ![
        "passed",
        "failed",
        "cancelled",
        "timed_out",
        "infrastructure_error",
      ].includes(base.run.state);
    }

    if (identity.praxisSessionId && identity.operationId) {
      const operation = await this.database.query<{
        praxisSessionId: string;
        projectId: string;
        environmentId: string;
        agentSessionId: string;
        praxisState: string;
        operationId: string;
        mutationIdentity: string;
        providerIdempotencyIdentity: string;
        adaptiveState: string;
        protectedState: string | null;
        adaptiveTruth: MutationTruth;
        protectedTruth: MutationTruth | null;
        functionalTruth: Q1Snapshot["operation"]["functionalTruth"] | null;
        operationKind: "ordinary_mutation" | "protected_mutation" | "read_only";
        dispatchCount: number;
      }>(
        `SELECT adaptive.session_id::text AS "praxisSessionId",
                session.project_id::text AS "projectId",session.environment_id::text AS "environmentId",
                session.agent_session_id::text AS "agentSessionId",session.state AS "praxisState",
                adaptive.operation_id AS "operationId",
                COALESCE(protected.mutation_identity,adaptive.idempotency_key) AS "mutationIdentity",
                COALESCE(protected.provider_idempotency_commitment,adaptive.idempotency_key)
                  AS "providerIdempotencyIdentity",
                adaptive.state AS "adaptiveState",protected.state AS "protectedState",
                COALESCE(adaptive.mutation_outcome,'not_attempted') AS "adaptiveTruth",
                protected.mutation_outcome AS "protectedTruth",
                adaptive.functional_result AS "functionalTruth",
                CASE WHEN adaptive.semantic_intent->>'type'='protectedTransaction' THEN 'protected_mutation'
                     WHEN adaptive.semantic_intent->>'type' IN ('observe','read') THEN 'read_only'
                     ELSE 'ordinary_mutation' END AS "operationKind",
                CASE WHEN COALESCE(protected.dispatch_state,'not_started') IN ('started','acknowledged')
                       OR adaptive.dispatch_boundary IN ('dispatching','dispatched','acknowledged') THEN 1 ELSE 0 END AS "dispatchCount"
           FROM adaptive_operations adaptive JOIN adaptive_sessions session ON session.id=adaptive.session_id
           LEFT JOIN protected_operations protected ON protected.owner_kind='authoring_session'
             AND protected.authoring_session_id=adaptive.session_id
             AND protected.operation_id=adaptive.operation_id
          WHERE adaptive.session_id=$1 AND adaptive.operation_id=$2`,
        [identity.praxisSessionId, identity.operationId],
      );
      const durableOperation = operation.rows[0];
      if (!durableOperation) throw new Error("Q1_REPOSITORY_OPERATION_NOT_FOUND");
      base.scope.praxisSessionId = durableOperation.praxisSessionId;
      base.scope.projectId = durableOperation.projectId;
      base.scope.environmentId = durableOperation.environmentId;
      base.scope.agentSessionId = durableOperation.agentSessionId;
      base.praxis.state = durableOperation.praxisState;
      base.operation.operationId = durableOperation.operationId;
      base.operation.mutationIdentity = durableOperation.mutationIdentity;
      base.operation.providerIdempotencyIdentity = durableOperation.providerIdempotencyIdentity;
      base.operation.kind = durableOperation.operationKind;
      base.operation.adaptiveProjectionTruth = durableOperation.adaptiveTruth;
      base.operation.protectedTruth = durableOperation.protectedTruth;
      base.operation.mutationTruth =
        durableOperation.protectedTruth ?? durableOperation.adaptiveTruth;
      base.operation.originalMutationTruth = base.operation.mutationTruth;
      base.operation.mutationHistory = [base.operation.mutationTruth];
      base.operation.functionalTruth = durableOperation.functionalTruth ?? "pending";
      base.operation.dispatchCount = durableOperation.dispatchCount;
      base.operation.dispatchPossible = durableOperation.dispatchCount > 0;
      base.operation.failureClassifiedNotApplied = base.operation.mutationTruth === "not_applied";
      base.operation.terminal = durableOperation.protectedState
        ? ["completed", "failed_not_applied", "compromised", "revoked", "abandoned"].includes(
            durableOperation.protectedState,
          )
        : ["completed", "failed"].includes(durableOperation.adaptiveState);
      if (base.operation.terminal) base.run.operationMutable = false;
    }
    return freezeSnapshot(base) as Q1Snapshot;
  }
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? U[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
