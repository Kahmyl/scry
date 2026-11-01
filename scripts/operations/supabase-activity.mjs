import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const intervalMs = 6 * 60 * 60 * 1000;
const statusPath = "/tmp/scry-supabase-activity.json";

export function activityConfig(env) {
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("SUPABASE_URL must be an HTTPS origin");
  if (url.pathname !== "/") throw new Error("SUPABASE_URL must be an HTTPS origin");
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!key?.startsWith("sb_publishable_"))
    throw new Error("Use a Supabase publishable key, not a privileged server key");
  return { endpoint: new URL("/rest/v1/rpc/scry_auth_healthcheck", url), key };
}

export async function checkActivity(config, { fetchImpl = fetch, signal } = {}) {
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "GET",
      headers: { apikey: config.key, accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: "http_error", httpStatus: response.status };
    }
    if ((await response.json()) !== true) return { ok: false, reason: "unexpected_response" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}

export function healthyStatus(status, now = Date.now()) {
  return (
    status?.ok === true &&
    Number.isFinite(status.checkedAt) &&
    now >= status.checkedAt &&
    now - status.checkedAt < intervalMs + 60_000
  );
}

export async function watchActivity(
  config,
  {
    signal,
    check = checkActivity,
    wait = sleep,
    save = (status) => writeFile(statusPath, JSON.stringify(status), { mode: 0o600 }),
    log = (status) => console.log(JSON.stringify({ event: "supabase_activity", ...status })),
  } = {},
) {
  while (!signal?.aborted) {
    const result = await check(config, { signal });
    if (signal?.aborted) break;
    const status = { ...result, checkedAt: Date.now() };
    await save(status);
    log(status);
    try {
      await wait(intervalMs, undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
}

async function main() {
  if (process.argv.includes("--health")) {
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    process.exitCode = healthyStatus(status) ? 0 : 1;
    return;
  }
  const config = activityConfig(process.env);
  if (!process.argv.includes("--watch")) {
    const result = await checkActivity(config);
    console.log(JSON.stringify({ event: "supabase_activity", ...result }));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  await watchActivity(config, { signal: shutdown.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error("Supabase activity check failed; inspect configuration and connectivity.");
    process.exitCode = 1;
  });
