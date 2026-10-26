import type { PoolClient } from "pg";

export function validateBrowserOwnerLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000)
    throw new Error("SCRY_BROWSER_OWNER_LEASE_INVALID");
}

/** Caller acquires the session first when it needs multiple resource locks.
 * Do not put the time predicate in the locking statement: it may be evaluated
 * before a lock wait. Ownership is checked against the current database clock
 * only after the exact owner row is locked. */
export async function lockLiveBrowserOwner(
  client: PoolClient,
  sessionId: string,
  generation: number,
  leaseToken?: string,
): Promise<void> {
  const locked = await client.query<{ state: string; lease_token: string }>(
    "SELECT state,lease_token FROM browser_owner_generations WHERE session_id=$1 AND generation=$2 FOR UPDATE",
    [sessionId, generation],
  );
  const owner = locked.rows[0];
  if (
    !owner ||
    owner.state !== "active" ||
    (leaseToken !== undefined && owner.lease_token !== leaseToken)
  )
    throw new Error("SCRY_BROWSER_OWNER_FENCED");
  const current = await client.query<{ live: boolean }>(
    "SELECT lease_expires_at>clock_timestamp() AS live FROM browser_owner_generations WHERE session_id=$1 AND generation=$2",
    [sessionId, generation],
  );
  if (!current.rows[0]?.live) throw new Error("SCRY_BROWSER_OWNER_FENCED");
}
