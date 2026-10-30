import test from "node:test";
import assert from "node:assert/strict";
import { BestEffortTasks } from "../src/best-effort-tasks.mjs";
test("stalled background maintenance cannot block active work or accumulate retries", async () => {
  let warnings = 0,
    hungCalls = 0,
    activeCalls = 0,
    release;
  const tasks = new BestEffortTasks(() => warnings++, 10);
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  const entries = [
    [
      "background",
      () => {
        hungCalls++;
        return hung;
      },
    ],
    [
      "active",
      async () => {
        activeCalls++;
      },
    ],
  ];
  await tasks.run(entries);
  await tasks.run(entries);
  assert.equal(hungCalls, 1);
  assert.equal(activeCalls, 2);
  assert.equal(tasks.pending.size, 1);
  assert.equal(warnings, 2);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tasks.pending.size, 0);
});
