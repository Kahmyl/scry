import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { OutcomeClassification, RunState } from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

export class RunAttemptRepository {
  constructor(private readonly database: Database) {}

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
        `UPDATE runs SET state = 'queued', phase = 'queued', queued_at = COALESCE(queued_at, now()),
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
      `UPDATE runs SET state = 'cancelled', phase = 'completed', outcome_classification = 'cancelled', updated_at = now()
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
          "UPDATE runs SET state = 'cancelled', phase = 'completed', outcome_classification = 'cancelled', updated_at = now() WHERE id = $1",
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
        "UPDATE runs SET state = 'preparing', phase = 'preparing', updated_at = now() WHERE id = $1",
        [runId],
      );
      return result.rows[0]!;
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
        "UPDATE runs SET state = 'running', phase = 'executing_action', updated_at = now() WHERE id = $1",
        [runId],
      );
      await client.query(
        `UPDATE mission_objective_orchestration SET state='running',lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE active_run_id=$1 AND state='queued'`,
        [runId],
      );
      return true;
    });
    if (!updated) throw new ConflictException("Attempt claim was lost");
  }

  async heartbeat(attemptId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE attempts SET heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state IN ('preparing','running','finalizing')
         RETURNING run_id`,
        [attemptId, claimToken],
      );
      if (!result.rowCount) return false;
      await client.query(
        `UPDATE protected_transactions SET lease_expires_at=now()+interval '30 seconds' WHERE run_id=$1 AND worker_lease_id=$2`,
        [result.rows[0]!.run_id, claimToken],
      );
      await client.query(
        `UPDATE protected_mutation_ledger SET lease_expires_at=now()+interval '30 seconds' WHERE run_id=$1 AND worker_lease_id=$2`,
        [result.rows[0]!.run_id, claimToken],
      );
      return true;
    });
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
        "UPDATE runs SET state = 'finalizing', phase = 'finalizing', updated_at = now() WHERE id = $1 AND state = 'running'",
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
      const structural = await client.query<{ structural: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM grounding_diagnostics WHERE run_id=$1 AND failure_code IN ('TARGET_AMBIGUOUS','NO_CAPABILITY_COMPATIBLE_CONTROL','INSUFFICIENT_EVIDENCE','GROUNDING_DRIFT_REQUIRES_CALIBRATION','TARGET_SCOPE_INVALID','TARGET_CHANGED_BEFORE_ACTION')) structural`,
        [runId],
      );
      const resultClassification =
        state === "passed" && outcomeClassification === "passed"
          ? "application_pass"
          : state === "cancelled"
            ? "cancelled"
            : structural.rows[0]!.structural ||
                outcomeClassification === "inconclusive_plan" ||
                outcomeClassification === "readiness_timeout"
              ? "calibration_required"
              : outcomeClassification === "assertion_failure"
                ? "application_failure"
                : "environment_failure";
      await client.query(
        `UPDATE runs SET state = $2, phase = 'completed', outcome_classification = $3,result_classification=$4, updated_at = now()
         WHERE id = $1 AND state IN ('preparing','running','finalizing')`,
        [runId, state, outcomeClassification, resultClassification],
      );
      await client.query(
        `UPDATE flow_compilations
         SET publication_gate=jsonb_build_object(
               'status',CASE
                 WHEN $2='passed' AND $3='application_pass'
                   AND NOT EXISTS(SELECT 1 FROM credential_incidents WHERE run_id=$1)
                 THEN 'certified' ELSE 'rejected' END,
               'certificationRunId',$1::text,
               'rejectionReasons',CASE
                 WHEN EXISTS(SELECT 1 FROM credential_incidents WHERE run_id=$1)
                   THEN jsonb_build_array('PRIVACY_INCIDENT')
                 WHEN $2='passed' AND $3='application_pass' THEN '[]'::jsonb
                 ELSE jsonb_build_array(upper($3))
               END,
               'requiredOutcome','application_pass'
             )
         WHERE certification_run_id=$1`,
        [runId, state, resultClassification],
      );
      await client.query(
        `INSERT INTO release_gate_metrics(
           project_id,mission_id,objective_id,compilation_id,category,name,value,safe_dimensions
         )
         SELECT r.project_id,r.mission_id,r.objective_id,r.compiled_contract_id,
                'certification',
                CASE WHEN $2='passed' AND $3='application_pass'
                  AND NOT EXISTS(SELECT 1 FROM credential_incidents WHERE run_id=$1)
                  THEN 'certification_run_passed'
                  WHEN EXISTS(SELECT 1 FROM credential_incidents WHERE run_id=$1)
                  THEN 'certification_privacy_rejected'
                  ELSE 'certification_run_rejected' END,
                1,
                jsonb_build_object('resultClassification',$3)
         FROM runs r
         WHERE r.id=$1 AND r.compiled_contract_id IS NOT NULL`,
        [runId, state, resultClassification],
      );
      await client.query(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata)
        SELECT mission_id,objective_id,agent_session_id,'run_completed',$2,$3::jsonb FROM runs WHERE id=$1`,
        [runId, `Run completed: ${state}`, JSON.stringify({ runId, state, outcomeClassification })],
      );
      await client.query(
        `UPDATE mission_objective_orchestration SET state=CASE WHEN $2='cancelled' THEN 'cancelled' WHEN $4='calibration_required' THEN 'blocked' ELSE 'awaiting_evidence' END,blocker_code=CASE WHEN $2='passed' THEN NULL WHEN $4='calibration_required' THEN 'CALIBRATION_REQUIRED' ELSE upper(COALESCE($3,$2)) END,blocker_details=jsonb_build_object('candidateRunState',$2,'outcomeClassification',$3,'resultClassification',$4),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE active_run_id=$1`,
        [runId, state, outcomeClassification, resultClassification],
      );
      if (resultClassification === "calibration_required") {
        const source = await client.query<any>(
          `SELECT r.mission_id,r.objective_id,r.environment_id,r.agent_session_id,fc.id compilation_id,fc.draft_id,fc.draft_version FROM runs r JOIN flow_compilations fc ON fc.id=r.compiled_contract_id WHERE r.id=$1`,
          [runId],
        );
        if (source.rowCount) {
          const item = source.rows[0];
          await client.query(
            `UPDATE flow_compilations SET status='calibration_required',invalidated_at=now() WHERE id=$1`,
            [item.compilation_id],
          );
          const probeId = randomUUID();
          await client.query(
            `INSERT INTO probe_sessions(id,draft_id,mission_id,objective_id,environment_id,draft_version,level,created_by_agent_session_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'inspection',$7,$8) ON CONFLICT(draft_id,idempotency_key) DO NOTHING`,
            [
              probeId,
              item.draft_id,
              item.mission_id,
              item.objective_id,
              item.environment_id,
              item.draft_version,
              item.agent_session_id,
              `auto-calibration:${runId}`,
            ],
          );
          await client.query(
            `INSERT INTO probe_outbox(probe_session_id,release_id,schema_fingerprint) SELECT id,$2,$3 FROM probe_sessions WHERE draft_id=$1 AND idempotency_key=$4 ON CONFLICT(probe_session_id) DO NOTHING`,
            [
              item.draft_id,
              process.env.SCRY_RELEASE_ID ?? "development",
              process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
              `auto-calibration:${runId}`,
            ],
          );
        }
      }
    });
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
        `UPDATE runs SET state = $2, phase = CASE WHEN $3::boolean THEN 'queued' ELSE 'completed' END,
                         outcome_classification = CASE WHEN $3::boolean THEN outcome_classification ELSE 'infrastructure_failure' END,
                         result_classification=CASE WHEN $3::boolean THEN result_classification ELSE 'infrastructure_failure' END,
                         updated_at = now()
         WHERE id = $1`,
        [runId, retry ? "queued" : "infrastructure_error", retry],
      );
      if (!retry)
        await client.query(
          `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata)
        SELECT mission_id,objective_id,agent_session_id,'run_completed','Run ended with infrastructure error',$2::jsonb FROM runs WHERE id=$1`,
          [runId, JSON.stringify({ runId, state: "infrastructure_error" })],
        );
      if (!retry)
        await client.query(
          `UPDATE mission_objective_orchestration SET state='blocked',blocker_code='INFRASTRUCTURE_FAILURE',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE active_run_id=$1`,
          [runId],
        );
      if (!retry) {
        await client.query(
          `UPDATE flow_compilations
           SET publication_gate=jsonb_build_object(
                 'status','rejected','certificationRunId',$1::text,
                 'rejectionReasons',jsonb_build_array('INFRASTRUCTURE_FAILURE'),
                 'requiredOutcome','application_pass'
               )
           WHERE certification_run_id=$1`,
          [runId],
        );
        await client.query(
          `INSERT INTO release_gate_metrics(
             project_id,mission_id,objective_id,compilation_id,category,name,value,
             safe_dimensions
           )
           SELECT project_id,mission_id,objective_id,compiled_contract_id,
                  'certification','certification_infrastructure_failure',1,
                  jsonb_build_object('retryExhausted',true)
           FROM runs WHERE id=$1 AND compiled_contract_id IS NOT NULL`,
          [runId],
        );
      }
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
          `UPDATE runs SET state = 'queued', phase = 'queued', updated_at = now()
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
