import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Coordinator } from "../src/coordinator.mjs";
import { PolicyDiagnostics } from "../src/policy-diagnostics.mjs";
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "scry-coordinator-test-"));
  const c = new Coordinator({
    root,
    environments: { env: { allowTesting: true, origins: ["http://example.invalid"] } },
  });
  const row = c.store.create("isolated", "env");
  const runtime = {
    row,
    tail: Promise.resolve(),
    protection: { clean: (x) => x },
    network: 0,
    policyDiagnostics: new PolicyDiagnostics(),
    pending: new Map(),
    recorder: {
      close: async (reason) => ({
        coverage: reason === "complete" ? "complete" : "partial",
        reason,
      }),
    },
  };
  c.live.set(row.id, runtime);
  return {
    c,
    row,
    runtime,
    async close() {
      await c.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("observation hard deadline preserves successful action truth and fences the browser", async () => {
  const h = setup();
  h.c.rpc = async (_r, m) => {
    if (m.tool === "browser_snapshot") throw new Error("BROWSER_HARD_DEADLINE");
    return { content: [{ type: "text", text: "Action completed" }], isError: false };
  };
  try {
    const r = await h.c.action(h.row.id, "once", "browser_click", { target: "e1" });
    assert.equal(r.receipt.execution, "succeeded");
    assert.equal(r.receipt.observation, "unavailable");
    assert.equal(h.c.live.has(h.row.id), false);
    assert.equal(h.c.status(h.row.id).evidence.coverage, "partial");
  } finally {
    await h.close();
  }
});
test("concurrent actions are serialized and durable retries do not re-dispatch", async () => {
  const h = setup();
  let active = 0,
    max = 0,
    calls = 0;
  h.c.rpc = async (_r, m) => {
    active++;
    max = Math.max(max, active);
    if (m.tool === "browser_click") calls++;
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { content: [], isError: false };
  };
  try {
    await Promise.all([
      h.c.action(h.row.id, "one", "browser_click", { target: "e1" }),
      h.c.action(h.row.id, "two", "browser_click", { target: "e2" }),
    ]);
    assert.equal(max, 1);
    assert.equal(calls, 2);
    const r = await h.c.action(h.row.id, "one", "browser_click", { target: "e1" });
    assert.equal(r.replay, true);
    assert.equal(calls, 2);
  } finally {
    await h.close();
  }
});
test("a failed application test can still have a complete recording", async () => {
  const h = setup();
  try {
    const r = await h.c.finish(h.row.id, "failed");
    assert.equal(r.state, "failed");
    assert.equal(r.evidence.coverage, "complete");
  } finally {
    await h.close();
  }
});
test("a native timeout is a failed tool with an unknown application outcome", async () => {
  const h = setup();
  h.c.rpc = async (_r, message) =>
    message.tool === "browser_click"
      ? {
          isError: true,
          content: [{ type: "text", text: "TimeoutError: performing click action" }],
        }
      : { isError: false, content: [] };
  try {
    const r = await h.c.action(h.row.id, "timeout", "browser_click", { target: "e1" });
    assert.equal(r.receipt.execution, "failed");
    assert.equal(r.receipt.businessOutcome, "unknown");
    assert.match(r.warning, /may already have changed/);
  } finally {
    await h.close();
  }
});
test("a missing secret is known not dispatched, rather than an uncertain browser change", async () => {
  const h = setup();
  let calls = 0;
  h.c.rpc = async () => {
    calls++;
    throw new Error("Must not dispatch");
  };
  try {
    const r = await h.c.action(h.row.id, "missing-secret", "browser_type_secret", {
      target: "e1",
      secretId: "absent",
    });
    assert.equal(r.receipt.execution, "failed");
    assert.equal(r.receipt.reason, "not_dispatched");
    assert.equal(calls, 0);
  } finally {
    await h.close();
  }
});
test("a read-only text wait timeout does not imply an uncertain application change", async () => {
  const h = setup();
  h.c.rpc = async (_r, message) =>
    message.tool === "browser_wait_for"
      ? { isError: true, content: [{ type: "text", text: "TimeoutError: waiting for text" }] }
      : { isError: false, content: [] };
  try {
    const r = await h.c.action(h.row.id, "read-timeout", "browser_wait_for", { text: "Absent" });
    assert.equal(r.receipt.execution, "failed");
    assert.equal(r.receipt.businessOutcome, "not_inferred");
    assert.doesNotMatch(r.warning ?? "", /may already have changed/);
  } finally {
    await h.close();
  }
});
test("adapter results are retained alongside independent observations; find stays focused", async () => {
  const h = setup();
  const calls = [];
  h.c.rpc = async (_r, message) => {
    calls.push(message.tool);
    return {
      content: [
        {
          type: "text",
          text: message.tool === "browser_snapshot" ? "Fresh view" : "Original result",
        },
      ],
      isError: false,
    };
  };
  try {
    const action = await h.c.action(h.row.id, "click", "browser_click", { target: "e1" });
    assert.deepEqual(
      action.content.map((c) => c.text),
      ["Original result", "Fresh view"],
    );
    calls.length = 0;
    const find = await h.c.action(h.row.id, "find", "browser_find", { text: "target" });
    assert.deepEqual(calls, ["browser_find"]);
    assert.deepEqual(
      find.content.map((c) => c.text),
      ["Original result"],
    );
  } finally {
    await h.close();
  }
});
