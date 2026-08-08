import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { AuthoringRuntimeCommandType, ClaimedAuthoringRuntimeCommand } from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

export type EnqueueAuthoringRuntimeCommandInput = {
  probeSessionId: string;
  missionId: string;
  agentSessionId: string;
  type: AuthoringRuntimeCommandType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

export type EnqueuedAuthoringRuntimeCommand = {
  id: string;
  state: "pending" | "claimed" | "completed" | "failed" | "cancelled";
  replayed: boolean;
};

type SettleCommandInput = {
  commandId: string;
  browserLeaseId: string;
  workerId: string;
  claimToken: string;
};

@Injectable()
export class AuthoringRuntimeCommandRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async enqueue(
    input: EnqueueAuthoringRuntimeCommandInput,
  ): Promise<EnqueuedAuthoringRuntimeCommand> {
    return this.db.transaction(async (client) => {
      const requestHash = hash({
        type: input.type,
        payload: input.payload,
        missionId: input.missionId,
        agentSessionId: input.agentSessionId,
      });
      const replay = await client.query<{
        id: string;
        state: EnqueuedAuthoringRuntimeCommand["state"];
        requestHash: string;
      }>(
        `SELECT command.id,command.state,command.request_hash AS "requestHash"
         FROM authoring_runtime_commands command
         JOIN probe_sessions probe
           ON probe.id=command.probe_session_id
          AND probe.mission_id=$4
         JOIN agent_sessions agent
           ON agent.id=$3
          AND agent.mission_id=probe.mission_id
          AND agent.status='active'
         WHERE command.probe_session_id=$1
           AND command.idempotency_key=$2`,
        [input.probeSessionId, input.idempotencyKey, input.agentSessionId, input.missionId],
      );
      if (replay.rowCount) {
        if (replay.rows[0]!.requestHash !== requestHash) {
          throw new Error("AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT");
        }
        return { id: replay.rows[0]!.id, state: replay.rows[0]!.state, replayed: true };
      }

      const runtime = await client.query<{
        probeSessionId: string;
        browserLeaseId: string;
      }>(
        `SELECT
           authoring.probe_session_id AS "probeSessionId",
           lease.id AS "browserLeaseId"
         FROM probe_authoring_sessions authoring
         JOIN authoring_browser_leases lease
           ON lease.id=authoring.browser_lease_id
          AND lease.probe_session_id=authoring.probe_session_id
         JOIN probe_sessions probe
           ON probe.id=authoring.probe_session_id
         JOIN agent_sessions agent
           ON agent.id=$3
          AND agent.mission_id=probe.mission_id
          AND agent.status='active'
         WHERE authoring.probe_session_id=$1
           AND probe.mission_id=$2
           AND probe.mode='interactive'
           AND probe.cancellation_requested_at IS NULL
           AND (
             (
               $4 IN ('observe_document','interact','advance_turn','suspend','cancel')
               AND authoring.status='active'
               AND lease.state='active'
             )
             OR (
               $4 IN ('resume','cancel')
               AND authoring.status='suspended'
               AND lease.state='suspended'
             )
           )
           AND lease.expires_at>now()
         FOR UPDATE OF authoring,lease`,
        [input.probeSessionId, input.missionId, input.agentSessionId, input.type],
      );

      const active = runtime.rows[0];

      if (!active) {
        throw new Error("AUTHORING_RUNTIME_NOT_ACTIVE");
      }

      const command = await client.query<EnqueuedAuthoringRuntimeCommand>(
        `INSERT INTO authoring_runtime_commands(
           probe_session_id,
           browser_lease_id,
           type,
           payload,
           idempotency_key,
           request_hash,
           created_by_agent_session_id
         )
         VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT (probe_session_id,idempotency_key)
         DO UPDATE
           SET idempotency_key=EXCLUDED.idempotency_key
         WHERE authoring_runtime_commands.request_hash=EXCLUDED.request_hash
         RETURNING
           id,
           state,
           (xmax<>0) AS replayed`,
        [
          input.probeSessionId,
          active.browserLeaseId,
          input.type,
          JSON.stringify(input.payload),
          input.idempotencyKey,
          requestHash,
          input.agentSessionId,
        ],
      );

      const result = command.rows[0];

      if (!result) {
        throw new Error("AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT");
      }

      return result;
    });
  }

  async claimNext(
    browserLeaseId: string,
    workerId: string,
  ): Promise<ClaimedAuthoringRuntimeCommand | undefined> {
    return this.db.transaction(async (client) => {
      const claimed = await client.query<ClaimedAuthoringRuntimeCommand>(
        `WITH candidate AS (
           SELECT command.id
           FROM authoring_runtime_commands command
           JOIN authoring_browser_leases lease
             ON lease.id=command.browser_lease_id
            AND lease.probe_session_id=command.probe_session_id
           JOIN probe_authoring_sessions authoring
             ON authoring.probe_session_id=command.probe_session_id
            AND authoring.browser_lease_id=lease.id
           WHERE command.browser_lease_id=$1
             AND lease.runtime_owner_id=$2
             AND lease.expires_at>now()
             AND command.state='pending'
             AND (
               (
                 lease.state='active'
                 AND authoring.status='active'
                 AND command.type IN (
                   'observe_document',
                   'interact',
                   'advance_turn',
                   'suspend',
                   'cancel'
                 )
               )
               OR (
                 lease.state='suspended'
                 AND authoring.status='suspended'
                 AND command.type IN ('resume','cancel')
               )
             )
           ORDER BY command.created_at
           FOR UPDATE OF command SKIP LOCKED
           LIMIT 1
         )
         UPDATE authoring_runtime_commands command
         SET state='claimed',
             claimed_by_runtime_owner_id=$2,
             claim_token=gen_random_uuid(),
             claimed_at=now(),
             updated_at=now()
         FROM candidate
         WHERE command.id=candidate.id
         RETURNING
           command.id,
           command.probe_session_id AS "probeSessionId",
           command.browser_lease_id AS "browserLeaseId",
           command.type,
           command.payload,
           command.claim_token AS "claimToken"`,
        [browserLeaseId, workerId],
      );

      return claimed.rows[0];
    });
  }

  heartbeatClaim(input: SettleCommandInput): Promise<boolean> {
    return this.db
      .query(
        `UPDATE authoring_runtime_commands command
         SET claimed_at=now(),updated_at=now()
         FROM authoring_browser_leases lease
         WHERE command.id=$1
           AND command.browser_lease_id=$2
           AND command.claimed_by_runtime_owner_id=$3
           AND command.claim_token=$4
           AND command.state='claimed'
           AND lease.id=command.browser_lease_id
           AND lease.runtime_owner_id=$3
           AND lease.state IN ('active','suspended')
         RETURNING command.id`,
        [input.commandId, input.browserLeaseId, input.workerId, input.claimToken],
      )
      .then((result) => Boolean(result.rowCount));
  }

  complete(
    input: SettleCommandInput & {
      safeResult: Record<string, unknown>;
    },
  ) {
    return this.settle(input, "completed", input.safeResult, undefined);
  }

  fail(
    input: SettleCommandInput & {
      safeError: Record<string, unknown>;
    },
  ) {
    return this.settle(input, "failed", undefined, input.safeError);
  }

  cancelPending(probeSessionId: string, exceptCommandId?: string) {
    return this.db
      .query(
        `WITH cancelled AS (
           UPDATE authoring_runtime_commands
           SET state='cancelled',
               completed_at=now(),
               updated_at=now()
           WHERE probe_session_id=$1
             AND state='pending'
             AND ($2::uuid IS NULL OR id<>$2)
           RETURNING id,probe_session_id
         )
         INSERT INTO authoring_runtime_command_results(
           command_id,
           probe_session_id,
           outcome,
           safe_result,
           safe_error
         )
         SELECT
           id,
           probe_session_id,
           'cancelled',
           NULL,
           '{"code":"AUTHORING_RUNTIME_CANCELLED"}'::jsonb
         FROM cancelled
         ON CONFLICT (command_id) DO NOTHING
         RETURNING command_id`,
        [probeSessionId, exceptCommandId ?? null],
      )
      .then((result) => result.rowCount);
  }

  async result(commandId: string) {
    const result = await this.db.query<{
      state: "pending" | "claimed" | "completed" | "failed" | "cancelled";
      outcome: "completed" | "failed" | "cancelled" | null;
      safeResult: Record<string, unknown> | null;
      safeError: Record<string, unknown> | null;
    }>(
      `SELECT command.state,result.outcome,
              result.safe_result AS "safeResult",result.safe_error AS "safeError"
       FROM authoring_runtime_commands command
       LEFT JOIN authoring_runtime_command_results result ON result.command_id=command.id
       WHERE command.id=$1`,
      [commandId],
    );
    return result.rows[0];
  }

  async recoverStaleClaims(before: Date): Promise<number> {
    const result = await this.db.query(
      `WITH stale AS (
         SELECT id,probe_session_id,payload,type,
           CASE
             WHEN type='interact' AND payload->'action'->>'type' IN
               ('click','fill','select','check','press','protectedTransaction') THEN true
             WHEN type='advance_turn' AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(payload->'operations','[]'::jsonb)) op
               WHERE op->'action'->>'type' IN
                 ('click','fill','select','check','press','protectedTransaction')
             ) THEN true
             ELSE false
           END AS mutating
         FROM authoring_runtime_commands
         WHERE state='claimed' AND claimed_at<$1
         FOR UPDATE SKIP LOCKED
       ), failed AS (
         UPDATE authoring_runtime_commands command
         SET state='failed',completed_at=now(),updated_at=now()
         FROM stale
         WHERE command.id=stale.id
         RETURNING command.id,command.probe_session_id,stale.mutating
       )
       INSERT INTO authoring_runtime_command_results(
         command_id,probe_session_id,outcome,safe_result,safe_error
       )
       SELECT id,probe_session_id,'failed',NULL,
         jsonb_build_object(
           'code','AUTHORING_COMMAND_LEASE_LOST',
           'mutationOutcome',CASE WHEN mutating THEN 'unknown' ELSE 'not_applied' END,
           'safeActions',CASE WHEN mutating
             THEN jsonb_build_array('reconcile_mutation','do_not_retry')
             ELSE jsonb_build_array('retry_same_idempotency_key') END
         )
       FROM failed
       ON CONFLICT(command_id) DO NOTHING`,
      [before],
    );
    return result.rowCount ?? 0;
  }

  private async settle(
    input: SettleCommandInput,
    outcome: "completed" | "failed",
    safeResult: Record<string, unknown> | undefined,
    safeError: Record<string, unknown> | undefined,
  ) {
    return this.db.transaction(async (client) => {
      const owned = await client.query<{
        probeSessionId: string;
      }>(
        `SELECT
           command.probe_session_id AS "probeSessionId"
         FROM authoring_runtime_commands command
         JOIN authoring_browser_leases lease
           ON lease.id=command.browser_lease_id
          AND lease.probe_session_id=command.probe_session_id
         WHERE command.id=$1
           AND command.browser_lease_id=$2
           AND command.claimed_by_runtime_owner_id=$3
           AND command.claim_token=$4
           AND command.state='claimed'
           AND lease.runtime_owner_id=$3
           AND lease.state IN ('active','suspended')
         FOR UPDATE OF command`,
        [input.commandId, input.browserLeaseId, input.workerId, input.claimToken],
      );

      const probeSessionId = owned.rows[0]?.probeSessionId;

      if (!probeSessionId) {
        return false;
      }

      await client.query(
        `UPDATE authoring_runtime_commands
         SET state=$2,
             completed_at=now(),
             updated_at=now()
         WHERE id=$1
           AND state='claimed'`,
        [input.commandId, outcome],
      );

      await client.query(
        `INSERT INTO authoring_runtime_command_results(
           command_id,
           probe_session_id,
           outcome,
           safe_result,
           safe_error
         )
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [
          input.commandId,
          probeSessionId,
          outcome,
          safeResult ? JSON.stringify(safeResult) : null,
          safeError ? JSON.stringify(safeError) : null,
        ],
      );

      return true;
    });
  }
}

function hash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
