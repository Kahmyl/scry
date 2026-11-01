import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityConfig,
  checkActivity,
  healthyStatus,
  watchActivity,
} from "./supabase-activity.mjs";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-only",
};
const config = activityConfig(env);

test("accepts only an HTTPS origin and a non-privileged publishable key", () => {
  assert.equal(config.endpoint.href, `${env.SUPABASE_URL}/rest/v1/rpc/scry_auth_healthcheck`);
  for (const SUPABASE_URL of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/other",
    "https://example.com/?token=private",
    "https://example.com/#private",
  ])
    assert.throws(() => activityConfig({ ...env, SUPABASE_URL }));
  for (const SUPABASE_PUBLISHABLE_KEY of [undefined, "", "sb_secret_private", "service-role-jwt"])
    assert.throws(() => activityConfig({ ...env, SUPABASE_PUBLISHABLE_KEY }));
});

test("calls only the read-only RPC with a bounded request and no user session", async () => {
  const result = await checkActivity(config, {
    fetchImpl: async (url, options) => {
      assert.equal(url.href, config.endpoint.href);
      assert.equal(options.method, "GET");
      assert.deepEqual(options.headers, { apikey: config.key, accept: "application/json" });
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return Response.json(true);
    },
  });
  assert.deepEqual(result, { ok: true });
});

test("a failed, missing, or unexpected RPC never reports healthy or leaks response data", async () => {
  for (const response of [
    Response.json(false),
    Response.json({ secret: "do-not-log" }),
    new Response("invalid-json"),
  ]) {
    const result = await checkActivity(config, { fetchImpl: async () => response });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("do-not-log"));
  }
  for (const status of [401, 404, 503]) {
    assert.deepEqual(
      await checkActivity(config, {
        fetchImpl: async () => new Response("private-provider-error", { status }),
      }),
      {
        ok: false,
        reason: "http_error",
        httpStatus: status,
      },
    );
  }
  assert.deepEqual(
    await checkActivity(config, {
      fetchImpl: async () => {
        throw new Error("private-key");
      },
    }),
    {
      ok: false,
      reason: "request_failed",
    },
  );
});

test("shutdown aborts an in-flight network request", async () => {
  const shutdown = new AbortController();
  const result = checkActivity(config, {
    signal: shutdown.signal,
    fetchImpl: async (_url, { signal }) => {
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
  });
  shutdown.abort();
  assert.deepEqual(await result, { ok: false, reason: "request_failed" });
});

test("health reflects the last actual query, including failure and stale or missing state", () => {
  const now = Date.now();
  assert.equal(healthyStatus({ ok: true, checkedAt: now }, now), true);
  for (const status of [
    undefined,
    {},
    { ok: false, checkedAt: now },
    { ok: true, checkedAt: now - 6 * 60 * 60 * 1000 - 60_001 },
    { ok: true, checkedAt: now + 1 },
  ])
    assert.equal(healthyStatus(status, now), false);
});

test("checks immediately, waits six hours between attempts, recovers, and shuts down cleanly", async () => {
  const shutdown = new AbortController();
  const saved = [];
  const logs = [];
  let attempts = 0;
  let waits = 0;
  await watchActivity(config, {
    signal: shutdown.signal,
    check: async () => {
      attempts++;
      return attempts === 1 ? { ok: false, reason: "request_failed" } : { ok: true };
    },
    save: async (status) => {
      saved.push(status);
    },
    log: (status) => logs.push(status),
    wait: async (duration) => {
      assert.equal(duration, 6 * 60 * 60 * 1000);
      assert.equal(attempts, ++waits);
      if (waits === 2) {
        shutdown.abort();
        throw new Error("aborted");
      }
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(
    saved.map(({ ok }) => ok),
    [false, true],
  );
  assert.deepEqual(logs, saved);
});
