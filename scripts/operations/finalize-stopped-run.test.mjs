import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeStoppedRun } from "./finalize-stopped-run.mjs";
const missionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = {
  missionId,
  runId,
  confirmation: "FINALIZE_STOPPED_RUN_AS_INCOMPLETE",
  token: "fictional-operator-secret",
};
const before = {
  id: runId,
  missionId,
  state: "running",
  runtimeAdapter: "playwright_mcp",
  ownerGeneration: "7",
  browserSessionState: "active",
  activity: [{ state: "completed", businessOutcome: "unknown" }],
};
const after = {
  ...before,
  state: "failed",
  outcomeClassification: "blocked",
  browserSessionState: "completed",
};
function fixture(rows) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return Response.json(rows.shift());
    },
  };
}
test("finalizes only the selected stopped Run through the API, preserves uncertainty and verifies release", async () => {
  const f = fixture([before, { replay: false }, after]);
  const r = await finalizeStoppedRun({ ...input, ...f });
  assert.deepEqual(r, {
    finalized: true,
    replay: false,
    runId,
    state: "failed",
    outcome: "blocked",
    browserReleased: true,
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].url, `http://127.0.0.1:4000/api/runs/${runId}/finalize`);
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.ownerGeneration, 7);
  assert.equal(body.outcome, "blocked");
  assert.ok(body.conclusion.includes("uncertain outcomes"));
  assert.ok(!JSON.stringify(r).includes(input.token));
});
test("requires explicit identity, confirmation and operator credential before any request", async () => {
  for (const change of [
    { missionId: "other" },
    { runId: "other" },
    { confirmation: "" },
    { token: "" },
  ]) {
    const f = fixture([]);
    await assert.rejects(finalizeStoppedRun({ ...input, ...f, ...change }));
    assert.equal(f.calls.length, 0);
  }
});
test("refuses wrong Mission, executing actions, unsupported profile and missing owner without writes", async () => {
  for (const row of [
    { ...before, missionId: runId },
    { ...before, activity: [{ state: "running" }] },
    { ...before, runtimeAdapter: "legacy" },
    { ...before, ownerGeneration: 0 },
  ]) {
    const f = fixture([row]);
    await assert.rejects(finalizeStoppedRun({ ...input, ...f }));
    assert.equal(f.calls.length, 1);
  }
});
test("already-terminal release is a read-only replay and never relabels a passed Run", async () => {
  const f = fixture([{ ...after, state: "passed", outcomeClassification: "passed" }]);
  const r = await finalizeStoppedRun({ ...input, ...f });
  assert.equal(r.replay, true);
  assert.equal(r.outcome, "passed");
  assert.equal(f.calls.length, 1);
});
test("does not report success when physical release or blocked outcome is unconfirmed", async () => {
  for (const change of [
    { browserSessionState: "active" },
    { outcomeClassification: "passed" },
    { missionId: runId },
  ]) {
    const f = fixture([before, {}, { ...after, ...change }]);
    await assert.rejects(finalizeStoppedRun({ ...input, ...f }));
  }
});
test("does not expose raw API failures or retry an uncertain POST", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return calls === 1
      ? Response.json(before)
      : new Response("fictional private raw detail", { status: 409 });
  };
  await assert.rejects(finalizeStoppedRun({ ...input, fetchFn }), /RUN_API_HTTP_409/);
  assert.equal(calls, 2);
});
test("re-reads a recovered owner generation once only for the typed lifecycle fencing response", async () => {
  const calls = [];
  const rows = [before, null, { ...before, ownerGeneration: "8" }, {}, after];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const row = rows.shift();
    return row === null
      ? Response.json({ message: { code: "SCRY_BROWSER_OWNER_FENCED" } }, { status: 409 })
      : Response.json(row);
  };
  assert.equal((await finalizeStoppedRun({ ...input, fetchFn })).browserReleased, true);
  assert.equal(JSON.parse(calls[1].init.body).ownerGeneration, 7);
  assert.equal(JSON.parse(calls[3].init.body).ownerGeneration, 8);
});
