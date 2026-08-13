import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import { Database } from "../../infrastructure/index.js";

const CLOSED_REASON = "HISTORICAL_MUTATION_ADMINISTRATIVELY_CLOSED";

type AdministrativeRow = {
  protectedOperationId: string;
  protectedState: string;
  protectedOutcome: string;
  dispatchState: string;
  dispatchSemantics: string;
  adaptiveState: string;
  adaptiveOutcome: string;
  sessionState: string;
  adaptiveReason: string | null;
  sessionReason: string | null;
};

@Injectable()
export class UnknownMutationAdministrationService {
  constructor(@Inject(Database) private readonly database: Database) {}

  /**
   * Permanently closes a post-dispatch unknown mutation without claiming that
   * it applied or did not apply. This method creates no dispatch authority and
   * is intentionally limited to the exact joined recovery state.
   */
  closeHistoricalUnknown(input: { sessionId: string; operationId: string }) {
    return this.database.transaction(async (client) => {
      const selected = await client.query<AdministrativeRow>(
        `SELECT protected.id::text AS "protectedOperationId",
                protected.state AS "protectedState",
                protected.mutation_outcome AS "protectedOutcome",
                protected.dispatch_state AS "dispatchState",
                protected.dispatch_semantics AS "dispatchSemantics",
                adaptive.state AS "adaptiveState",
                adaptive.mutation_outcome AS "adaptiveOutcome",
                session.state AS "sessionState",
                adaptive.decision_boundary->>'reasonCode' AS "adaptiveReason",
                session.decision_boundary->>'reasonCode' AS "sessionReason"
           FROM protected_operations protected
           JOIN adaptive_operations adaptive
             ON adaptive.session_id=protected.authoring_session_id
            AND adaptive.operation_id=protected.operation_id
           JOIN adaptive_sessions session ON session.id=protected.authoring_session_id
          WHERE protected.owner_kind='authoring_session'
            AND protected.authoring_session_id=$1
            AND protected.operation_id=$2
          FOR UPDATE OF protected,adaptive,session`,
        [input.sessionId, input.operationId],
      );
      if (selected.rowCount !== 1) throw new NotFoundException("UNKNOWN_MUTATION_OPERATION_NOT_FOUND");
      const row = selected.rows[0]!;
      const alreadyClosed =
        row.protectedState === "abandoned" &&
        row.protectedOutcome === "unknown" &&
        row.adaptiveState === "failed" &&
        row.adaptiveOutcome === "unknown" &&
        row.sessionState === "cancelled" &&
        row.adaptiveReason === CLOSED_REASON &&
        row.sessionReason === CLOSED_REASON;
      if (alreadyClosed) return { classification: "unknown_historical_closed" as const, replayed: true };

      if (
        row.protectedState !== "recovery_required" ||
        row.protectedOutcome !== "unknown" ||
        row.dispatchState !== "acknowledged" ||
        row.dispatchSemantics !== "mutation" ||
        row.adaptiveState !== "failed" ||
        row.adaptiveOutcome !== "unknown" ||
        row.sessionState !== "recovery_required"
      ) throw new ConflictException("UNKNOWN_MUTATION_ADMINISTRATIVE_STATE_INVALID");

      const safeEvidence = JSON.stringify({
        classification: "unknown_historical_closed",
        providerCorrelation: "unavailable",
        redispatchAllowed: false,
      });
      const boundary = JSON.stringify({
        type: "mutation_reconciliation_required",
        reasonCode: CLOSED_REASON,
        safeActions: [],
      });

      const transitioned = await client.query(
        `UPDATE protected_operations
            SET state='abandoned',phase='historical_unknown_closed',version=version+1,
                failure_code=$2,recovery_class='do_not_retry',
                completed_at=COALESCE(completed_at,now()),lease_owner=NULL,lease_expires_at=NULL,
                updated_at=now()
          WHERE id=$1 AND state='recovery_required' AND mutation_outcome='unknown'
            AND dispatch_state='acknowledged' AND dispatch_semantics='mutation'
          RETURNING id`,
        [row.protectedOperationId, CLOSED_REASON],
      );
      if (transitioned.rowCount !== 1) throw new ConflictException("UNKNOWN_MUTATION_ADMINISTRATIVE_FENCE_LOST");
      await client.query(
        `INSERT INTO protected_operation_transitions(
           protected_operation_id,sequence,from_state,to_state,phase,fencing_token,reason_code,safe_diagnostics
         ) SELECT $1,COALESCE(max(sequence),0)+1,'recovery_required','abandoned',
                  'historical_unknown_closed',
                  (SELECT fencing_token FROM protected_operations WHERE id=$1),$2,$3::jsonb
             FROM protected_operation_transitions WHERE protected_operation_id=$1`,
        [row.protectedOperationId, CLOSED_REASON, safeEvidence],
      );
      await client.query(
        `UPDATE adaptive_operations
            SET decision_boundary=$3::jsonb,
                safe_outcome=COALESCE(safe_outcome,'{}'::jsonb) ||
                  jsonb_build_object('reasonCode',$4::text,'mutationOutcome','unknown'),
                completed_at=COALESCE(completed_at,now())
          WHERE session_id=$1 AND operation_id=$2
            AND state='failed' AND mutation_outcome='unknown'`,
        [input.sessionId, input.operationId, boundary, CLOSED_REASON],
      );
      const session = await client.query(
        `UPDATE adaptive_sessions
            SET state='cancelled',decision_boundary=$2::jsonb,version=version+1,
                completed_at=COALESCE(completed_at,now()),updated_at=now()
          WHERE id=$1 AND state='recovery_required'
          RETURNING id`,
        [input.sessionId, boundary],
      );
      if (session.rowCount !== 1) throw new ConflictException("UNKNOWN_MUTATION_SESSION_FENCE_LOST");
      await client.query(
        `INSERT INTO adaptive_session_events(session_id,sequence,type,safe_facts)
         SELECT $1,COALESCE(max(sequence),0)+1,'session_cancelled',$2::jsonb
           FROM adaptive_session_events WHERE session_id=$1`,
        [input.sessionId, safeEvidence],
      );
      return { classification: "unknown_historical_closed" as const, replayed: false };
    });
  }
}

export { CLOSED_REASON as UNKNOWN_HISTORICAL_MUTATION_CLOSED_REASON };
