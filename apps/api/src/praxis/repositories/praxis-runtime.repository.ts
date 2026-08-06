import { Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/index.js";

@Injectable()
export class PraxisRuntimeRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async resolveActiveBrowserLease(
    probeSessionId: string,
    workerId: string,
  ) {
    const result = await this.db.query<{
      browserLeaseId: string;
    }>(
      `SELECT id AS "browserLeaseId"
       FROM authoring_browser_leases
       WHERE probe_session_id=$1
         AND runtime_owner_id=$2
         AND state IN ('active','suspended')
         AND expires_at>now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [probeSessionId, workerId],
    );

    return result.rows[0]?.browserLeaseId;
  }

  async assertOwnedBrowserLease(
    browserLeaseId: string,
    probeSessionId: string,
    workerId: string,
  ) {
    const result = await this.db.query(
      `SELECT id
       FROM authoring_browser_leases
       WHERE id=$1
         AND probe_session_id=$2
         AND runtime_owner_id=$3
         AND state IN ('active','suspended')
         AND expires_at>now()
       LIMIT 1`,
      [browserLeaseId, probeSessionId, workerId],
    );

    return Boolean(result.rowCount);
  }

  async claim(requestId: string, workerId: string, claimToken: string) {
    return this.db.transaction(async (c) => {
      const request = await c.query<any>(
        `SELECT id,status,payload
         FROM praxis_candidate_requests
         WHERE id=$1
         FOR UPDATE`,
        [requestId],
      );

      if (!request.rowCount || request.rows[0].status !== "queued") return;

      await c.query(
        `UPDATE praxis_candidate_requests
         SET status='claimed',
             worker_id=$2,
             claim_token=$3,
             claimed_at=now(),
             updated_at=now()
         WHERE id=$1`,
        [requestId, workerId, claimToken],
      );

      return {
        ...request.rows[0],
        workerId,
        claimToken,
      };
    });
  }

  async get(requestId: string) {
    const result = await this.db.query(
      `SELECT
         id,
         status,
         result,
         failure_code AS "failureCode",
         created_at AS "createdAt",
         completed_at AS "completedAt"
       FROM praxis_candidate_requests
       WHERE id=$1`,
      [requestId],
    );

    return result.rows[0];
  }

  async complete(runtime: any, result: unknown) {
    const resultUpdate = await this.db.query(
      `UPDATE praxis_candidate_requests
       SET status='completed',
           result=$3::jsonb,
           completed_at=now(),
           updated_at=now()
       WHERE id=$1
         AND claim_token=$2`,
      [runtime.id, runtime.claimToken, JSON.stringify(result)],
    );

    return Boolean(resultUpdate.rowCount);
  }

  async fail(runtime: any, code: string) {
    await this.db.query(
      `UPDATE praxis_candidate_requests
       SET status='failed',
           failure_code=$3,
           completed_at=now(),
           updated_at=now()
       WHERE id=$1
         AND claim_token=$2`,
      [runtime.id, runtime.claimToken, code],
    );
  }
}
