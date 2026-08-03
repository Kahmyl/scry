import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  OutcomeClassification,
  PraxisResult,
  RecordingTimelineEntry,
  RunEvent,
  RunState,
} from "@scry/contracts";

import { Database } from "./database.js";
import { decryptCredential } from "./credential.crypto.js";
import { encryptCredential } from "./credential.crypto.js";
import { ProtectedTransactionRepository } from "./protected-transaction.repository.js";
import { ProtectedExecutionStateRepository } from "./protected-execution-state.repository.js";
import { ExecutionObservationRepository } from "./execution-observation.repository.js";
import { RunAttemptRepository } from "./run-attempt.repository.js";

@Injectable()
export class ExecutionRepository {
  private readonly protectedTransactions: ProtectedTransactionRepository;
  private readonly protectedState: ProtectedExecutionStateRepository;
  private readonly observations: ExecutionObservationRepository;
  private readonly attempts: RunAttemptRepository;

  constructor(@Inject(Database) private readonly database: Database) {
    this.protectedTransactions = new ProtectedTransactionRepository(database);
    this.protectedState = new ProtectedExecutionStateRepository(database);
    this.observations = new ExecutionObservationRepository(database);
    this.attempts = new RunAttemptRepository(database);
  }

  async heartbeatWorker(
    workerId: string,
    releaseId: string,
    schemaFingerprint: string,
    praxis: { contractVersion: number; runtimeVersion: string; scoringPolicyVersion: number },
  ) {
    await this.database.query(
      `INSERT INTO worker_heartbeats(worker_id, release_id, schema_fingerprint, praxis_contract_version, praxis_runtime_version, praxis_scoring_policy_version, heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (worker_id) DO UPDATE SET release_id = EXCLUDED.release_id,
         schema_fingerprint = EXCLUDED.schema_fingerprint,
         praxis_contract_version = EXCLUDED.praxis_contract_version,
         praxis_runtime_version = EXCLUDED.praxis_runtime_version,
         praxis_scoring_policy_version = EXCLUDED.praxis_scoring_policy_version,
         heartbeat_at = now()`,
      [
        workerId,
        releaseId,
        schemaFingerprint,
        praxis.contractVersion,
        praxis.runtimeVersion,
        praxis.scoringPolicyVersion,
      ],
    );
  }

  setRunPhase(runId: string, phase: string) {
    return this.database.query(`UPDATE runs SET phase = $2, updated_at = now() WHERE id = $1`, [
      runId,
      phase,
    ]);
  }

  claimProtectedTransaction(
    runId: string,
    workerLeaseId: string,
    input: {
      operationId: string;
      mutationKind: "one_time" | "repeatable";
      programDigest: string;
      inputSchemaDigest: string;
      inputDigest: string;
    },
  ) {
    return this.protectedTransactions.claimProtectedTransaction(runId, workerLeaseId, input);
  }

  transitionProtectedMutation(
    runId: string,
    workerLeaseId: string,
    input: { operationId: string; fencingToken: number; expected: string; next: string },
  ) {
    return this.protectedTransactions.transitionProtectedMutation(runId, workerLeaseId, input);
  }

  recordProtectedTransaction(
    runId: string,
    workerLeaseId: string,
    input: {
      operationId: string;
      fencingToken: number;
      phase: string;
      facts?: Record<string, unknown>;
    },
  ) {
    return this.protectedTransactions.recordProtectedTransaction(runId, workerLeaseId, input);
  }

  protectedRecoveryDecision(runId: string, operationId: string) {
    return this.protectedTransactions.protectedRecoveryDecision(runId, operationId);
  }

  recordContextProvenance(
    runId: string,
    input: { contextId: string; provenance: string; operationId: string },
  ) {
    return this.protectedState.recordContextProvenance(runId, input);
  }

  persistCapturedSecret(input: {
    runId: string;
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }) {
    return this.protectedState.persistCapturedSecret(input);
  }

  persistGeneratedPublicValue(input: {
    runId: string;
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }) {
    return this.protectedState.persistGeneratedPublicValue(input);
  }

  resolveGeneratedPublicValue(runId: string, valueId: string) {
    return this.protectedState.resolveGeneratedPublicValue(runId, valueId);
  }

  markCapturedCredentialCompromised(
    runId: string,
    credentialId: string,
    code: string,
    operationId: string,
  ) {
    return this.protectedState.markCapturedCredentialCompromised(
      runId,
      credentialId,
      code,
      operationId,
    );
  }

  establishCheckpoint(
    runId: string,
    input: {
      checkpoint: { id: string; restorationUrl: string; continueAtStepId: string };
      payload: unknown;
      bindingFingerprint: string;
      expiresAt: string;
    },
  ) {
    return this.protectedState.establishCheckpoint(runId, input);
  }

  claimCheckpoint(runId: string, checkpointId: string) {
    return this.protectedState.claimCheckpoint(runId, checkpointId);
  }

  completeCheckpoint(
    runId: string,
    checkpointId: string,
    outcome: "verified" | "failed" | "destroyed",
    reasonCode?: string,
  ) {
    return this.protectedState.completeCheckpoint(runId, checkpointId, outcome, reasonCode);
  }

  verifyCalibrationAttestation(
    runId: string,
    attestationId: string,
    operationId: string,
    operationDigest: string,
    structureFingerprint: string,
  ) {
    return this.protectedState.verifyCalibrationAttestation(
      runId,
      attestationId,
      operationId,
      operationDigest,
      structureFingerprint,
    );
  }

  captureCredential(runId: string, name: string, value: string) {
    return this.protectedState.captureCredential(runId, name, value);
  }

  async groundingHistory(runId: string, intentDigest: string) {
    const result = await this.database.query<{
      fingerprint: import("@scry/contracts").SemanticFingerprint;
    }>(
      `SELECT h.fingerprint FROM runs r JOIN environments e ON e.id=r.environment_id JOIN semantic_target_history h ON h.project_id=r.project_id AND h.environment_id=r.environment_id AND h.flow_revision_id=r.flow_revision_id AND h.origin=e.base_origin AND h.intent_digest=$2 WHERE r.id=$1`,
      [runId, intentDigest],
    );
    return result.rows[0]?.fingerprint;
  }

  markQueued(...args: Parameters<RunAttemptRepository["markQueued"]>) {
    return this.attempts.markQueued(...args);
  }
  requestCancellation(...args: Parameters<RunAttemptRepository["requestCancellation"]>) {
    return this.attempts.requestCancellation(...args);
  }
  cancelQueuedRun(...args: Parameters<RunAttemptRepository["cancelQueuedRun"]>) {
    return this.attempts.cancelQueuedRun(...args);
  }
  claimAttempt(...args: Parameters<RunAttemptRepository["claimAttempt"]>) {
    return this.attempts.claimAttempt(...args);
  }

  async loadExecution(runId: string) {
    const result = await this.database.query(
      `SELECT id, flow_revision_id AS "flowRevisionId", environment_id AS "environmentId", plan_snapshot AS "planSnapshot", policy_snapshot AS "policySnapshot", veil_policy_snapshot AS "veilPolicySnapshot",
              environment_snapshot AS "environmentSnapshot",
              execution_snapshot AS "executionSnapshot"
       FROM runs WHERE id = $1`,
      [runId],
    );
    if (!result.rowCount) throw new NotFoundException("Run not found");
    return result.rows[0]!;
  }

  async resolveCredential(runId: string, credentialId: string) {
    const result = await this.lookupCredential(runId, credentialId);
    if (result.status === "resolved") return result.value;
    if (result.status === "storage_failure")
      throw new Error(`CREDENTIAL_STORAGE_FAILURE: ${result.message}`);
    throw new BadRequestException(
      `CREDENTIAL_${result.status.toUpperCase()}: Protected credential is unavailable`,
    );
  }

  async lookupCredential(runId: string, credentialId: string): Promise<CredentialLookupResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        credentialId,
      )
    ) {
      return { status: "invalid_reference" };
    }
    try {
      const runSecret = await this.database.query<{
        ciphertext: Buffer;
        initializationVector: Buffer;
        authenticationTag: Buffer;
        securityStatus: string;
      }>(
        `SELECT ciphertext, initialization_vector AS "initializationVector", authentication_tag AS "authenticationTag", security_status AS "securityStatus"
         FROM run_captured_secrets WHERE id=$2 AND run_id=$1`,
        [runId, credentialId],
      );
      if (runSecret.rowCount) {
        if (runSecret.rows[0]!.securityStatus !== "active") return { status: "compromised" };
        return { status: "resolved", value: decryptCredential(runSecret.rows[0]!) };
      }
      const authorization = await this.database.query<{ projectId: string; authorized: boolean }>(
        `SELECT project_id AS "projectId",
                COALESCE(environment_snapshot->'secretRefs', '[]'::jsonb) ? ($2::uuid)::text AS authorized
         FROM runs WHERE id = $1`,
        [runId, credentialId],
      );
      if (!authorization.rowCount || !authorization.rows[0]!.authorized)
        return { status: "not_authorized" };
      const credential = await this.database.query<{
        ciphertext: Buffer;
        initializationVector: Buffer;
        authenticationTag: Buffer;
        deletedAt?: Date;
        securityStatus: string;
      }>(
        `SELECT credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag", credential.deleted_at AS "deletedAt",
              credential.security_status AS "securityStatus"
       FROM project_credentials credential
       WHERE credential.project_id = $1 AND credential.id = $2`,
        [authorization.rows[0]!.projectId, credentialId],
      );
      if (!credential.rowCount || credential.rows[0]!.deletedAt) return { status: "deleted" };
      if (credential.rows[0]!.securityStatus !== "active") return { status: "compromised" };
      return { status: "resolved", value: decryptCredential(credential.rows[0]!) };
    } catch (error) {
      return {
        status: "storage_failure",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  markRunning(...args: Parameters<RunAttemptRepository["markRunning"]>) {
    return this.attempts.markRunning(...args);
  }
  heartbeat(...args: Parameters<RunAttemptRepository["heartbeat"]>) {
    return this.attempts.heartbeat(...args);
  }
  markFinalizing(...args: Parameters<RunAttemptRepository["markFinalizing"]>) {
    return this.attempts.markFinalizing(...args);
  }
  isCancellationRequested(...args: Parameters<RunAttemptRepository["isCancellationRequested"]>) {
    return this.attempts.isCancellationRequested(...args);
  }

  appendEvent(...args: Parameters<ExecutionObservationRepository["appendEvent"]>) {
    return this.observations.appendEvent(...args);
  }

  recordGroundingDiagnostic(
    ...args: Parameters<ExecutionObservationRepository["recordGroundingDiagnostic"]>
  ) {
    return this.observations.recordGroundingDiagnostic(...args);
  }

  recordPraxisResult(...args: Parameters<ExecutionObservationRepository["recordPraxisResult"]>) {
    return this.observations.recordPraxisResult(...args);
  }

  recordAssertion(...args: Parameters<ExecutionObservationRepository["recordAssertion"]>) {
    return this.observations.recordAssertion(...args);
  }

  recordStepResult(...args: Parameters<ExecutionObservationRepository["recordStepResult"]>) {
    return this.observations.recordStepResult(...args);
  }

  recordArtifact(...args: Parameters<ExecutionObservationRepository["recordArtifact"]>) {
    return this.observations.recordArtifact(...args);
  }

  recordCaptureEpochs(...args: Parameters<ExecutionObservationRepository["recordCaptureEpochs"]>) {
    return this.observations.recordCaptureEpochs(...args);
  }

  recordArtifactTimeline(
    ...args: Parameters<ExecutionObservationRepository["recordArtifactTimeline"]>
  ) {
    return this.observations.recordArtifactTimeline(...args);
  }

  completeAttempt(...args: Parameters<RunAttemptRepository["completeAttempt"]>) {
    return this.attempts.completeAttempt(...args);
  }
  failAttempt(...args: Parameters<RunAttemptRepository["failAttempt"]>) {
    return this.attempts.failAttempt(...args);
  }
  recoverStaleAttempts(...args: Parameters<RunAttemptRepository["recoverStaleAttempts"]>) {
    return this.attempts.recoverStaleAttempts(...args);
  }
}

export type CredentialLookupResult =
  | { status: "resolved"; value: string }
  | { status: "invalid_reference" | "not_authorized" | "deleted" | "compromised" }
  | { status: "storage_failure"; message: string };

export function classifyOriginalAfterConfirmation(
  confirmationState: RunState,
  confirmationClassification: OutcomeClassification,
): OutcomeClassification | null {
  if (confirmationState === "passed") return "non_reproduced_failure";
  if (confirmationClassification === "assertion_failure") return "confirmed_product_failure";
  if (confirmationClassification === "readiness_timeout") return "readiness_timeout";
  return null;
}
