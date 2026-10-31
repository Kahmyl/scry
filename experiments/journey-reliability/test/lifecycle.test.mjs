import test from "node:test";
import assert from "node:assert/strict";
import { InteractionLifecycle } from "./lifecycle.mjs";
const deferred = () => {
  let resolve;
  return { promise: new Promise((r) => (resolve = r)), resolve: (v) => resolve(v) };
};
const spec = (extra = {}) => ({
  id: "action",
  intent: { operation: "save" },
  prepare: async () => true,
  execute: async () => {},
  observe: async () => "matched",
  ...extra,
});
test("failed precondition never dispatches or replays", async () => {
  const life = new InteractionLifecycle();
  let count = 0;
  const s = spec({ prepare: async () => false, execute: async () => count++ });
  assert.equal((await life.run(s)).status, "not_dispatched");
  await life.run(s);
  assert.equal(count, 0);
});
test("deadline retains ownership and returns immutable response snapshots", async () => {
  const life = new InteractionLifecycle(),
    gate = deferred();
  let count = 0;
  const s = spec({
    execute: async () => {
      count++;
      await gate.promise;
    },
    deadlineMs: 10,
  });
  const pending = await life.run(s);
  assert.equal(pending.status, "pending_after_deadline");
  const copy = await life.run(s);
  copy.status = "forged";
  assert.equal(life.get("action").status, "pending_after_deadline");
  assert.equal((await life.run(spec({ id: "second" }))).status, "session_busy");
  gate.resolve();
  assert.equal((await life.settled("action")).status, "verified");
  assert.equal(pending.status, "pending_after_deadline");
  assert.equal(count, 1);
});
test("read-only reconciliation excludes interleaving mutation", async () => {
  const life = new InteractionLifecycle(),
    gate = deferred();
  await life.run(
    spec({
      observe: async () => {
        throw Error("lost observation");
      },
    }),
  );
  const inspecting = life.reconcile("action", async () => {
    await gate.promise;
    return "matched";
  });
  assert.equal((await life.run(spec({ id: "second" }))).status, "session_busy");
  gate.resolve();
  assert.equal((await inspecting).status, "verified");
  assert.equal((await life.run(spec({ id: "second" }))).status, "verified");
});
test("failed inspection releases its lock without inventing success", async () => {
  const life = new InteractionLifecycle();
  await life.run(spec({ observe: async () => "inconclusive" }));
  await assert.rejects(
    life.reconcile("action", async () => {
      throw Error("observer unavailable");
    }),
  );
  assert.equal(life.busy, false);
  assert.equal(life.get("action").status, "needs_inspection");
});
test("a mismatched expected state does not authorize mutation replay", async () => {
  const life = new InteractionLifecycle();
  let count = 0;
  const s = spec({ execute: async () => count++, observe: async () => "mismatch" });
  assert.equal((await life.run(s)).status, "failed_expected_condition");
  await life.run(s);
  assert.equal(count, 1);
});
test("identity conflict and receipt quota fail explicitly without eviction", async () => {
  const life = new InteractionLifecycle({ capacity: 1 });
  await life.run(spec());
  assert.equal(
    (await life.run(spec({ intent: { operation: "purchase" } }))).status,
    "identity_conflict",
  );
  assert.equal((await life.run(spec({ id: "other" }))).status, "capacity_exhausted");
  assert.equal((await life.run(spec())).status, "verified");
  assert.equal(life.size, 1);
  assert.throws(() => new InteractionLifecycle({ capacity: Infinity }));
});
