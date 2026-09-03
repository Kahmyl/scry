import type { QueryResult, QueryResultRow } from "pg";

type Queryable = {
  query<T extends QueryResultRow = any>(
    sql: string,
    values?: unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

/** Retire only reservations that never compiled a program or attempted dispatch. */
export async function retireUnusedPreparedOperations(client: Queryable, praxisSessionId: string) {
  const abandoned = await client.query<{ id: string; fencingToken: number; previousState: string }>(
    `WITH unused AS (SELECT id,state FROM protected_operations
           WHERE praxis_session_id=$1 AND authority_model='canonical'
             AND state IN ('reserved','planned') AND program_digest IS NULL
             AND dispatch_state='not_started' AND mutation_outcome='not_attempted'
           FOR UPDATE)
         UPDATE protected_operations operation SET state='abandoned',phase='abandoned_before_dispatch',
           version=version+1,mutation_outcome='not_applied',
           failure_code='PREPARED_OPERATION_ABANDONED',recovery_class='do_not_retry',
           completed_at=now(),updated_at=now(),safe_diagnostics='{"dispatchAttempted":false}'::jsonb
         FROM unused WHERE operation.id=unused.id
         RETURNING operation.id,operation.runtime_fencing_epoch AS "fencingToken",unused.state AS "previousState"`,
    [praxisSessionId],
  );
  if (abandoned.rowCount) {
    const ids = abandoned.rows.map((row) => row.id);
    await client.query(
      `UPDATE prepared_execution_capabilities SET state='invalidated'
            WHERE protected_operation_id=ANY($1::uuid[]) AND state='reserved'`,
      [ids],
    );
    await client.query(
      `UPDATE value_use_grants SET state='revoked',revoked_at=now()
            WHERE consumer_protected_operation_id=ANY($1::uuid[]) AND state='active'`,
      [ids],
    );
    await client.query(
      `UPDATE operation_value_bindings SET state='revoked',revoked_at=now()
            WHERE consumer_protected_operation_id=ANY($1::uuid[]) AND state='active'`,
      [ids],
    );
    for (const operation of abandoned.rows)
      await client.query(
        `INSERT INTO protected_operation_transitions(
               protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics
             ) SELECT $1,COALESCE(max(sequence),0)+1,$3,'abandoned',
               'abandoned_before_dispatch',$2,'{"dispatchAttempted":false}'::jsonb
               FROM protected_operation_transitions WHERE protected_operation_id=$1`,
        [operation.id, operation.fencingToken, operation.previousState],
      );
  }
  return { abandoned: abandoned.rows.map((operation) => operation.id) };
}
