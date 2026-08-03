import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { decryptCredential, encryptCredential } from "./credential.crypto.js";
import { Database } from "./database.js";

@Injectable()
export class ProbeRuntimeRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async claim(sessionId: string, workerId: string, claimToken: string) {
    return this.db.transaction(async (c) => {
      const session = await c.query<any>(
        `SELECT p.id,p.draft_id AS "draftId",p.draft_version AS "draftVersion",p.level,p.state,p.authentication_contract_revision_id AS "authenticationContractRevisionId",d.project_id AS "projectId",p.environment_id AS "environmentId",d.plan,e.policy,project.authoring_policy AS "authoringPolicy" FROM probe_sessions p JOIN flow_drafts d ON d.id=p.draft_id JOIN environments e ON e.id=p.environment_id AND e.project_id=d.project_id JOIN projects project ON project.id=d.project_id WHERE p.id=$1 FOR UPDATE OF p`,
        [sessionId],
      );
      if (
        !session.rowCount ||
        session.rows[0].state !== "queued" ||
        session.rows[0].cancellation_requested_at
      )
        return;
      const id = randomUUID();
      const attempt = await c.query<any>(
        `INSERT INTO probe_attempts(id,probe_session_id,attempt_number,state,worker_id,claim_token,heartbeat_at,started_at) SELECT $1,$2,COALESCE(max(attempt_number),0)+1,'claimed',$3,$4,now(),now() FROM probe_attempts WHERE probe_session_id=$2 RETURNING id`,
        [id, sessionId, workerId, claimToken],
      );
      await c.query(
        `UPDATE probe_sessions SET state='claimed',current_attempt_id=$2,started_at=COALESCE(started_at,now()) WHERE id=$1`,
        [sessionId, attempt.rows[0].id],
      );
      return { ...session.rows[0], attemptId: attempt.rows[0].id, claimToken };
    });
  }
  async running(runtime: any) {
    const result = await this.db.query(
      `UPDATE probe_attempts SET state='running',heartbeat_at=now() WHERE id=$1 AND claim_token=$2 RETURNING id`,
      [runtime.attemptId, runtime.claimToken],
    );
    if (result.rowCount)
      await this.db.query(
        `UPDATE probe_sessions SET state='running' WHERE id=$1 AND current_attempt_id=$2`,
        [runtime.id, runtime.attemptId],
      );
    return Boolean(result.rowCount);
  }
  heartbeat(runtime: any) {
    return this.db
      .query(
        `UPDATE probe_attempts SET heartbeat_at=now() WHERE id=$1 AND claim_token=$2 AND state='running' RETURNING id`,
        [runtime.attemptId, runtime.claimToken],
      )
      .then((r) => Boolean(r.rowCount));
  }
  cancelled(runtime: any) {
    return this.db
      .query<{ cancelled: boolean }>(
        `SELECT cancellation_requested_at IS NOT NULL AS cancelled FROM probe_sessions WHERE id=$1`,
        [runtime.id],
      )
      .then((r) => r.rows[0]?.cancelled ?? true);
  }
  async complete(runtime: any, result: unknown) {
    return this.db.transaction(async (c) => {
      const owned = await c.query(
        `UPDATE probe_attempts SET state='completed',completed_at=now(),heartbeat_at=now() WHERE id=$1 AND claim_token=$2 AND state='running' RETURNING id`,
        [runtime.attemptId, runtime.claimToken],
      );
      if (!owned.rowCount) return false;
      await c.query(
        `UPDATE probe_sessions SET state='completed',result=$3::jsonb,completed_at=now() WHERE id=$1 AND current_attempt_id=$2`,
        [runtime.id, runtime.attemptId, JSON.stringify(result)],
      );
      await c.query(
        `UPDATE flow_drafts SET state='editing',updated_at=now() WHERE id=$1 AND state='probing'`,
        [runtime.draftId],
      );
      await c.query(
        `INSERT INTO probe_events(probe_session_id,sequence,type,safe_payload) SELECT $1,COALESCE(max(sequence),0)+1,'completed',$2::jsonb FROM probe_events WHERE probe_session_id=$1`,
        [runtime.id, JSON.stringify({ allResolved: (result as any)?.allResolved ?? false })],
      );
      return true;
    });
  }
  async fail(runtime: any, code: string, provenance = "infrastructure") {
    return this.db.transaction(async (c) => {
      await c.query(
        `UPDATE probe_attempts SET state='failed',completed_at=now(),safe_diagnostics=jsonb_build_object('code',$3::text) WHERE id=$1 AND claim_token=$2`,
        [runtime.attemptId, runtime.claimToken, code],
      );
      await c.query(
        `UPDATE probe_sessions SET state='failed',failure_provenance=$3,reason_code=$4,completed_at=now() WHERE id=$1 AND current_attempt_id=$2`,
        [runtime.id, runtime.attemptId, provenance, code],
      );
      await c.query(
        `UPDATE flow_drafts SET state='editing',updated_at=now() WHERE id=$1 AND state='probing'`,
        [runtime.draftId],
      );
    });
  }
  async resolveCredential(runtime: any, reference: string) {
    const result = await this.db.query<any>(
      `SELECT c.ciphertext,c.initialization_vector AS "initializationVector",c.authentication_tag AS "authenticationTag" FROM project_credentials c JOIN environments e ON e.id=$1 AND e.project_id=c.project_id WHERE c.id=$2 AND c.project_id=$3 AND c.security_status='active' AND c.deleted_at IS NULL AND e.secret_refs ? ($2::uuid)::text`,
      [runtime.environmentId, reference, runtime.projectId],
    );
    if (!result.rowCount) throw new Error("PROBE_CREDENTIAL_UNAVAILABLE");
    return decryptCredential(result.rows[0]);
  }
  async storeAuthenticatedState(
    runtime: any,
    state: unknown,
    structuralFingerprint: string,
    runtimeHash: string,
  ) {
    if (
      !runtime.authenticationContractRevisionId ||
      runtime.authoringPolicy?.authenticatedSessionReuse !== true
    )
      return;
    const contract = await this.db.query<any>(
      `SELECT c.application_origin,r.contract FROM authentication_contract_revisions r JOIN authentication_contracts c ON c.id=r.contract_id WHERE r.id=$1 AND c.project_id=$2 AND c.environment_id=$3 AND r.revoked_at IS NULL`,
      [runtime.authenticationContractRevisionId, runtime.projectId, runtime.environmentId],
    );
    if (!contract.rowCount || contract.rows[0].contract.sessionReuse !== "project_policy_opt_in")
      return;
    const encrypted = encryptCredential(JSON.stringify(state));
    const maximum = Math.min(
      Number(runtime.authoringPolicy.maximumSessionLeaseMs ?? 28_800_000),
      28_800_000,
    );
    await this.db.query(
      `INSERT INTO authenticated_session_leases(project_id,environment_id,authentication_contract_revision_id,origin,runtime_hash,structural_fingerprint,ciphertext,initialization_vector,authentication_tag,lease_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,gen_random_uuid(),now()+($10::bigint*interval '1 millisecond'))`,
      [
        runtime.projectId,
        runtime.environmentId,
        runtime.authenticationContractRevisionId,
        contract.rows[0].application_origin,
        runtimeHash,
        structuralFingerprint,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        maximum,
      ],
    );
  }
  async recoverStale(before: Date) {
    return this.db.transaction(async (c) => {
      const rows = await c.query<{ id: string }>(
        `SELECT p.id FROM probe_sessions p JOIN probe_attempts a ON a.id=p.current_attempt_id WHERE p.state IN ('claimed','running') AND a.heartbeat_at<$1 FOR UPDATE`,
        [before],
      );
      for (const row of rows.rows) {
        await c.query(
          `UPDATE probe_attempts SET state='failed',completed_at=now(),safe_diagnostics=jsonb_build_object('code','PROBE_WORKER_LEASE_LOST') WHERE id=(SELECT current_attempt_id FROM probe_sessions WHERE id=$1)`,
          [row.id],
        );
        await c.query(
          `UPDATE probe_sessions SET state='queued',current_attempt_id=NULL WHERE id=$1`,
          [row.id],
        );
        await c.query(
          `INSERT INTO probe_outbox(probe_session_id,release_id,schema_fingerprint) VALUES($1,$2,$3) ON CONFLICT(probe_session_id) DO UPDATE SET published_at=NULL,last_error=NULL`,
          [
            row.id,
            process.env.SCRY_RELEASE_ID ?? "development",
            process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
          ],
        );
      }
      return rows.rows.map((row) => row.id);
    });
  }
}
