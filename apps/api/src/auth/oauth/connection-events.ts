import type { PoolClient } from "pg";

export type ConnectionOutcome = "renewed" | "retry_recovered" | "replay_refused" | "disconnected";

/** Safe bounded operational facts, never token values or raw protocol errors. */
export async function recordConnectionEvent(
  client: PoolClient,
  connectionId: string,
  outcome: ConnectionOutcome,
) {
  await client.query("INSERT INTO oauth_connection_events(connection_id,outcome) VALUES($1,$2)", [
    connectionId,
    outcome,
  ]);
  await client.query(
    `DELETE FROM oauth_connection_events WHERE connection_id=$1 AND id NOT IN
    (SELECT id FROM oauth_connection_events WHERE connection_id=$1 ORDER BY created_at DESC,id DESC LIMIT 32)`,
    [connectionId],
  );
}
