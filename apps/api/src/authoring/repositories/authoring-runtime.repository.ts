import { Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/index.js";

export type ClaimedAuthoringRuntime = {
  probeSessionId: string;
  browserLeaseId: string;
  environmentId: string;
  policy: unknown;
};

@Injectable()
export class AuthoringRuntimeRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async claimNext(workerId: string): Promise<ClaimedAuthoringRuntime | undefined> {
    return this.db.transaction(async (client) => {
      const candidate = await client.query<ClaimedAuthoringRuntime>(
        `SELECT
           authoring.probe_session_id AS "probeSessionId",
           lease.id AS "browserLeaseId",
           probe.environment_id AS "environmentId",
           environment.policy
         FROM authoring_browser_leases lease
         JOIN probe_authoring_sessions authoring
           ON authoring.browser_lease_id=lease.id
          AND authoring.probe_session_id=lease.probe_session_id
         JOIN probe_sessions probe
           ON probe.id=authoring.probe_session_id
         JOIN environments environment
           ON environment.id=probe.environment_id
         WHERE lease.state='provisioning'
           AND lease.runtime_owner_id IS NULL
           AND lease.expires_at>now()
           AND authoring.status='starting'
           AND probe.mode='interactive'
           AND probe.cancellation_requested_at IS NULL
         ORDER BY lease.created_at
         FOR UPDATE OF lease SKIP LOCKED
         LIMIT 1`,
      );

      const runtime = candidate.rows[0];

      if (!runtime) {
        return undefined;
      }

      const claimed = await client.query<ClaimedAuthoringRuntime>(
        `UPDATE authoring_browser_leases
         SET runtime_owner_id=$2,
             heartbeat_at=now(),
             updated_at=now()
         WHERE id=$1
           AND state='provisioning'
           AND runtime_owner_id IS NULL
         RETURNING
           probe_session_id AS "probeSessionId",
           id AS "browserLeaseId"`,
        [runtime.browserLeaseId, workerId],
      );

      if (!claimed.rowCount) {
        return undefined;
      }

      return runtime;
    });
  }

  async activate(browserLeaseId: string, workerId: string) {
    const result = await this.db.query(
      `UPDATE authoring_browser_leases
       SET state='active',
           heartbeat_at=now(),
           updated_at=now()
       WHERE id=$1
         AND runtime_owner_id=$2
         AND state='provisioning'
       RETURNING id`,
      [browserLeaseId, workerId],
    );

    if (result.rowCount) {
      await this.db.query(
        `UPDATE probe_authoring_sessions
         SET status='active',
             updated_at=now()
         WHERE browser_lease_id=$1
           AND status='starting'`,
        [browserLeaseId],
      );
    }

    return Boolean(result.rowCount);
  }

  heartbeat(browserLeaseId: string, workerId: string) {
    return this.db
      .query(
        `UPDATE authoring_browser_leases
         SET heartbeat_at=now(),
             updated_at=now()
         WHERE id=$1
           AND runtime_owner_id=$2
           AND state='active'
         RETURNING id`,
        [browserLeaseId, workerId],
      )
      .then((result) => Boolean(result.rowCount));
  }

  async release(
    browserLeaseId: string,
    workerId: string,
    outcome: "completed" | "cancelled",
  ) {
    return this.db.transaction(async (client) => {
      const owned = await client.query<{ probeSessionId: string }>(
        `SELECT probe_session_id AS "probeSessionId"
         FROM authoring_browser_leases
         WHERE id=$1
           AND runtime_owner_id=$2
           AND state IN (
             'provisioning',
             'active',
             'suspended',
             'releasing'
           )
         FOR UPDATE`,
        [browserLeaseId, workerId],
      );

      const probeSessionId = owned.rows[0]?.probeSessionId;

      if (!probeSessionId) {
        return false;
      }

      await client.query(
        `UPDATE authoring_browser_leases
         SET state='released',
             released_at=now(),
             updated_at=now()
         WHERE id=$1
           AND runtime_owner_id=$2`,
        [browserLeaseId, workerId],
      );

      await client.query(
        `UPDATE probe_authoring_sessions
         SET status=$2,
             completed_at=COALESCE(completed_at,now()),
             updated_at=now(),
             pending_interaction=NULL
         WHERE probe_session_id=$1
           AND status NOT IN (
             'completed',
             'cancelled',
             'crashed'
           )`,
        [probeSessionId, outcome],
      );

      await client.query(
        `INSERT INTO probe_events(
           probe_session_id,
           sequence,
           type,
           safe_payload
         )
         SELECT
           $1,
           COALESCE(max(sequence),0)+1,
           $2,
           '{}'::jsonb
         FROM probe_events
         WHERE probe_session_id=$1`,
        [
          probeSessionId,
          outcome === "completed"
            ? "authoring_runtime_released"
            : "authoring_session_cancelled",
        ],
      );

      return true;
    });
  }

  async recoverStale(before: Date) {
    return this.db.transaction(async (client) => {
      const stale = await client.query<{
        browserLeaseId: string;
        probeSessionId: string;
      }>(
        `SELECT
           lease.id AS "browserLeaseId",
           lease.probe_session_id AS "probeSessionId"
         FROM authoring_browser_leases lease
         JOIN probe_authoring_sessions authoring
           ON authoring.browser_lease_id=lease.id
         WHERE lease.state IN ('provisioning','active','suspended')
           AND lease.runtime_owner_id IS NOT NULL
           AND lease.heartbeat_at<$1
           AND authoring.status IN (
             'starting',
             'active',
             'suspended',
             'completing'
           )
         FOR UPDATE OF lease SKIP LOCKED`,
        [before],
      );

      for (const runtime of stale.rows) {
        await client.query(
          `UPDATE authoring_browser_leases
           SET state='crashed',
               updated_at=now()
           WHERE id=$1`,
          [runtime.browserLeaseId],
        );

        await client.query(
          `UPDATE probe_authoring_sessions
           SET status='crashed',
               completed_at=COALESCE(completed_at,now()),
               updated_at=now(),
               pending_interaction=NULL
           WHERE probe_session_id=$1`,
          [runtime.probeSessionId],
        );

        await client.query(
          `INSERT INTO probe_events(
             probe_session_id,
             sequence,
             type,
             safe_payload
           )
           SELECT
             $1,
             COALESCE(max(sequence),0)+1,
             'authoring_runtime_crashed',
             '{}'::jsonb
           FROM probe_events
           WHERE probe_session_id=$1`,
          [runtime.probeSessionId],
        );
      }

      return stale.rows.map(({ probeSessionId }) => probeSessionId);
    });
  }
}
