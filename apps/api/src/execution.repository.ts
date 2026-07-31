import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Artifact, OutcomeClassification, RunEvent, RunState } from "@scry/contracts";

import { Database } from "./database.js";
import { decryptCredential } from "./credential.crypto.js";
import { encryptCredential } from "./credential.crypto.js";

@Injectable()
export class ExecutionRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async markQueued(runId: string) {
    return this.database.transaction(async (client) => {
      const run = await client.query(
        "SELECT state, cancellation_requested_at FROM runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      const row = run.rows[0]!;
      if (!["draft", "queued"].includes(row.state)) {
        throw new ConflictException(`Run cannot be queued from state ${row.state}`);
      }
      if (row.cancellation_requested_at) {
        throw new ConflictException("Cancelled run cannot be queued");
      }
      const result = await client.query(
        `UPDATE runs SET state = 'queued', queued_at = COALESCE(queued_at, now()),
                         updated_at = now()
         WHERE id = $1
         RETURNING id, state, queued_at AS "queuedAt"`,
        [runId],
      );
      return result.rows[0]!;
    });
  }

  async requestCancellation(runId: string) {
    const result = await this.database.query(
      `UPDATE runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, now()),
                       updated_at = now()
       WHERE id = $1
         AND state NOT IN ('passed','failed','cancelled','timed_out','infrastructure_error')
       RETURNING id, state, cancellation_requested_at AS "cancellationRequestedAt"`,
      [runId],
    );
    if (!result.rowCount) throw new ConflictException("Run is missing or already terminal");
    return result.rows[0]!;
  }

  async cancelQueuedRun(runId: string) {
    await this.database.query(
      `UPDATE runs SET state = 'cancelled', outcome_classification = 'cancelled', updated_at = now()
       WHERE id = $1 AND state = 'queued'`,
      [runId],
    );
  }

  async claimAttempt(runId: string, workerId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const run = await client.query(
        `SELECT state, cancellation_requested_at FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      if (run.rows[0]!.cancellation_requested_at) {
        await client.query(
          "UPDATE runs SET state = 'cancelled', outcome_classification = 'cancelled', updated_at = now() WHERE id = $1",
          [runId],
        );
        return undefined;
      }
      if (run.rows[0]!.state !== "queued") {
        throw new ConflictException(`Run cannot be claimed from state ${run.rows[0]!.state}`);
      }
      const result = await client.query(
        `INSERT INTO attempts(
           run_id, attempt_number, state, started_at, heartbeat_at, worker_id, claim_token
         )
         SELECT $1, COALESCE(MAX(attempt_number), 0) + 1, 'preparing',
                now(), now(), $2, $3
         FROM attempts WHERE run_id = $1
         RETURNING id, run_id AS "runId", attempt_number AS "attemptNumber",
                   state, started_at AS "startedAt", claim_token AS "claimToken",
                   created_at AS "createdAt"`,
        [runId, workerId, claimToken],
      );
      await client.query(
        "UPDATE runs SET state = 'preparing', updated_at = now() WHERE id = $1",
        [runId],
      );
      return result.rows[0]!;
    });
  }

  async loadExecution(runId: string) {
    const result = await this.database.query(
      `SELECT id, plan_snapshot AS "planSnapshot", policy_snapshot AS "policySnapshot",
              environment_snapshot AS "environmentSnapshot",
              execution_snapshot AS "executionSnapshot"
       FROM runs WHERE id = $1`,
      [runId],
    );
    if (!result.rowCount) throw new NotFoundException("Run not found");
    return result.rows[0]!;
  }

  async resolveCredential(runId: string, credentialId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credentialId)) {
      throw new BadRequestException(
        `Protected credential reference "${credentialId}" is invalid or unavailable for this Flow.`,
      );
    }
    const result = await this.database.query<{
      ciphertext: Buffer;
      initializationVector: Buffer;
      authenticationTag: Buffer;
    }>(
      `SELECT credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag"
       FROM runs run
       JOIN project_credentials credential
         ON credential.project_id = run.project_id
        AND credential.id = $2
        AND credential.deleted_at IS NULL
       WHERE run.id = $1`,
      [runId, credentialId],
    );
    if (!result.rowCount) throw new NotFoundException("Saved credential is missing or unavailable");
    return decryptCredential(result.rows[0]!);
  }

  async captureCredential(runId: string, name: string, value: string) {
    const encrypted = encryptCredential(value);
    return this.database.transaction(async (client) => {
      const run = await client.query(
        `SELECT project_id, environment_id FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      const credential = await client.query(
        `INSERT INTO project_credentials(
           project_id, name, ciphertext, initialization_vector, authentication_tag
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          run.rows[0]!.project_id,
          name,
          encrypted.ciphertext,
          encrypted.initializationVector,
          encrypted.authenticationTag,
        ],
      );
      const credentialId = String(credential.rows[0]!.id);
      await client.query(
        `UPDATE environments
         SET secret_refs = CASE
           WHEN secret_refs @> to_jsonb(ARRAY[$2::text]) THEN secret_refs
           ELSE secret_refs || to_jsonb($2::text)
         END
         WHERE id = $1`,
        [run.rows[0]!.environment_id, credentialId],
      );
      return { credentialId };
    });
  }

  async markRunning(runId: string, attemptId: string, claimToken: string) {
    const updated = await this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts SET state = 'running', heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state = 'preparing'
         RETURNING id`,
        [attemptId, claimToken],
      );
      if (!attempt.rowCount) return false;
      await client.query(
        "UPDATE runs SET state = 'running', updated_at = now() WHERE id = $1",
        [runId],
      );
      return true;
    });
    if (!updated) throw new ConflictException("Attempt claim was lost");
  }

  async heartbeat(attemptId: string, claimToken: string) {
    const result = await this.database.query(
      `UPDATE attempts SET heartbeat_at = now()
       WHERE id = $1 AND claim_token = $2 AND state IN ('preparing','running','finalizing')
       RETURNING id`,
      [attemptId, claimToken],
    );
    return Boolean(result.rowCount);
  }

  async markFinalizing(runId: string, attemptId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts SET state = 'finalizing', heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state = 'running'
         RETURNING id`,
        [attemptId, claimToken],
      );
      if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
      await client.query(
        "UPDATE runs SET state = 'finalizing', updated_at = now() WHERE id = $1 AND state = 'running'",
        [runId],
      );
    });
  }

  async isCancellationRequested(runId: string) {
    const result = await this.database.query(
      "SELECT cancellation_requested_at IS NOT NULL AS cancelled FROM runs WHERE id = $1",
      [runId],
    );
    return Boolean(result.rows[0]?.cancelled);
  }

  async appendEvent(
    attemptId: string,
    claimToken: string,
    event: Omit<RunEvent, "attemptId" | "runId">,
  ) {
    const result = await this.database.query(
      `INSERT INTO run_events(attempt_id, sequence, type, payload, occurred_at)
       SELECT $1, $3, $4, $5::jsonb, $6
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", sequence, type, payload,
                 occurred_at AS "occurredAt", created_at AS "createdAt"`,
      [
        attemptId,
        claimToken,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordAssertion(input: {
    attemptId: string;
    claimToken: string;
    stepId: string;
    assertionIndex: number;
    assertionType: string;
    status: "passed" | "failed" | "unevaluated";
    error?: string;
  }) {
    const result = await this.database.query(
      `INSERT INTO assertion_results(
         attempt_id, step_id, assertion_index, assertion_type, status, error
       )
       SELECT $1, $3, $4, $5, $6, $7
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId",
                 assertion_index AS "assertionIndex", assertion_type AS "assertionType",
                 status, error, created_at AS "createdAt"`,
      [
        input.attemptId,
        input.claimToken,
        input.stepId,
        input.assertionIndex,
        input.assertionType,
        input.status,
        input.error ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordArtifact(input: {
    attemptId: string;
    claimToken: string;
    stepId?: string;
    artifact: Artifact;
    storageKey?: string;
    retentionUntil?: string;
  }) {
    const result = await this.database.query(
      `INSERT INTO artifacts(
         id, attempt_id, step_id, kind, status, content_type, storage_key,
         size_bytes, checksum_sha256, retention_until, observation
       )
       SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
       FROM attempts WHERE id = $2 AND claim_token = $3
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId", kind, status,
                 content_type AS "contentType", storage_key AS "storageKey",
                 size_bytes AS "sizeBytes", checksum_sha256 AS "checksumSha256",
                 retention_until AS "retentionUntil", observation,
                 created_at AS "createdAt"`,
      [
        input.artifact.id,
        input.attemptId,
        input.claimToken,
        input.stepId ?? null,
        input.artifact.kind,
        input.artifact.status,
        input.artifact.contentType,
        input.storageKey ?? null,
        input.artifact.sizeBytes ?? null,
        input.artifact.checksumSha256 ?? null,
        input.retentionUntil ?? null,
        input.artifact.observation ? JSON.stringify(input.artifact.observation) : null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async completeAttempt(
    runId: string,
    attemptId: string,
    claimToken: string,
    state: Extract<RunState, "passed" | "failed" | "cancelled" | "timed_out">,
    outcomeClassification: OutcomeClassification,
    error?: string,
  ) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts
         SET state = $3, completed_at = now(), heartbeat_at = now(), error = $4
         WHERE id = $1 AND claim_token = $2
           AND state IN ('preparing','running','finalizing')
         RETURNING id`,
        [attemptId, claimToken, state, error ?? null],
      );
      if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
      await client.query(
        `UPDATE runs SET state = $2, outcome_classification = $3, updated_at = now()
         WHERE id = $1 AND state IN ('preparing','running','finalizing')`,
        [runId, state, outcomeClassification],
      );
      const confirmation = await client.query(
        `SELECT confirmation_of_run_id FROM runs WHERE id = $1`,
        [runId],
      );
      const originalRunId = confirmation.rows[0]?.confirmation_of_run_id as string | undefined;
      if (originalRunId) {
        const originalClassification = classifyOriginalAfterConfirmation(
          state,
          outcomeClassification,
        );
        await client.query(
          `UPDATE runs
           SET outcome_classification = COALESCE($2, outcome_classification),
               confirmation_run_id = $1,
               resolved_at = CASE WHEN $3 = 'passed' THEN now() ELSE resolved_at END,
               resolved_by_run_id = CASE WHEN $3 = 'passed' THEN $1 ELSE resolved_by_run_id END,
               updated_at = now()
           WHERE id = $4`,
          [runId, originalClassification, state, originalRunId],
        );
      }
      if (state === "passed") {
        await client.query(
          `WITH RECURSIVE ancestors AS (
             SELECT rerun_of_run_id AS id FROM runs WHERE id = $1
             UNION ALL
             SELECT runs.rerun_of_run_id
             FROM runs JOIN ancestors ON runs.id = ancestors.id
             WHERE runs.rerun_of_run_id IS NOT NULL
           )
           UPDATE runs
           SET resolved_at = now(), resolved_by_run_id = $1, updated_at = now()
           WHERE id IN (SELECT id FROM ancestors WHERE id IS NOT NULL)
             AND state IN ('failed','timed_out','infrastructure_error')
             AND resolved_at IS NULL`,
          [runId],
        );
      }
    });
  }

  async createConfirmationRun(runId: string, readinessTimeoutMultiplier = 2) {
    const result = await this.database.query(
      `INSERT INTO runs(
         project_id, environment_id, plan_version_id, state,
         plan_snapshot, environment_snapshot, policy_snapshot, execution_snapshot,
         confirmation_of_run_id
       )
       SELECT project_id, environment_id, plan_version_id, 'draft',
              plan_snapshot, environment_snapshot, policy_snapshot,
              execution_snapshot || jsonb_build_object(
                'confirmation', true,
                'readinessTimeoutMultiplier', LEAST($2::numeric, 2)
              ), id
       FROM runs source
       WHERE source.id = $1
         AND source.confirmation_of_run_id IS NULL
         AND source.confirmation_run_id IS NULL
         AND source.outcome_classification = 'readiness_timeout'
         AND source.plan_snapshot->>'protocolVersion' = '2'
         AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.confirmation_of_run_id = source.id)
       RETURNING id`,
      [runId, readinessTimeoutMultiplier],
    );
    if (!result.rowCount) return undefined;
    const confirmationId = String(result.rows[0]!.id);
    await this.database.query(
      `UPDATE runs SET confirmation_run_id = $2, updated_at = now() WHERE id = $1`,
      [runId, confirmationId],
    );
    return confirmationId;
  }

  async failAttempt(
    runId: string,
    attemptId: string,
    claimToken: string,
    error: string,
    retry: boolean,
  ) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts
         SET state = 'infrastructure_error', completed_at = now(),
             heartbeat_at = now(), error = $3
         WHERE id = $1 AND claim_token = $2
           AND state IN ('preparing','running','finalizing')
         RETURNING id`,
        [attemptId, claimToken, error],
      );
      if (!attempt.rowCount) return;
      await client.query(
        `UPDATE runs SET state = $2,
                         outcome_classification = CASE WHEN $3::boolean THEN outcome_classification
                                                       ELSE 'infrastructure_failure' END,
                         updated_at = now()
         WHERE id = $1`,
        [runId, retry ? "queued" : "infrastructure_error", retry],
      );
    });
  }

  async recoverStaleAttempts(staleBefore: Date) {
    return this.database.transaction(async (client) => {
      const stale = await client.query(
        `UPDATE attempts
         SET state = 'infrastructure_error', completed_at = now(),
             error = 'Worker heartbeat expired'
         WHERE state IN ('preparing','running','finalizing')
           AND heartbeat_at < $1
         RETURNING run_id`,
        [staleBefore],
      );
      const runIds = [...new Set(stale.rows.map((row) => String(row.run_id)))];
      if (runIds.length > 0) {
        await client.query(
          `UPDATE runs SET state = 'queued', updated_at = now()
           WHERE id = ANY($1::uuid[])
             AND cancellation_requested_at IS NULL`,
          [runIds],
        );
        await client.query(
          `UPDATE runs SET state = 'cancelled', outcome_classification = 'cancelled', updated_at = now()
           WHERE id = ANY($1::uuid[])
             AND cancellation_requested_at IS NOT NULL`,
          [runIds],
        );
      }
      return runIds;
    });
  }
}

export function classifyOriginalAfterConfirmation(
  confirmationState: RunState,
  confirmationClassification: OutcomeClassification,
): OutcomeClassification | null {
  if (confirmationState === "passed") return "non_reproduced_failure";
  if (confirmationClassification === "assertion_failure") return "confirmed_product_failure";
  if (confirmationClassification === "readiness_timeout") return "readiness_timeout";
  return null;
}
