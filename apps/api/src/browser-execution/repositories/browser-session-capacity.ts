import type { PoolClient } from "pg";

export function browserSessionLimit(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.SCRY_BROWSER_MAX_LIVE_SESSIONS ?? "1";
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1000)
    throw new Error("SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID");
  return Number(raw);
}

/** Admission, not a browser scheduler. The existing active Session is the durable
 * reservation through startup, between commands and through recovered closure.
 * All creators take the same transaction lock before checking exact replay or
 * capacity. No browser, file work or external call occurs under this lock.
 * A lost lease is NOT physical exit and never frees a slot. */
export async function admitBrowserSession<T>(
  client: PoolClient,
  replay: () => Promise<T | undefined>,
  create: () => Promise<T>,
): Promise<T> {
  const limit = browserSessionLimit();
  await client.query("SELECT pg_advisory_xact_lock(1935897209,1)");
  const existing = await replay();
  if (existing !== undefined) return existing;
  const active = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM browser_execution_sessions WHERE state='active'",
  );
  if (active.rows[0]!.count >= limit) throw new Error("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
  return create();
}
