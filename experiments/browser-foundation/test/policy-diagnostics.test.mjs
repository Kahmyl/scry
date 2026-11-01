import test from "node:test";
import assert from "node:assert/strict";
import { PolicyDiagnostics } from "../src/policy-diagnostics.mjs";
test("retry storms have bounded diagnostics and exact aggregate deltas", () => {
  const d = new PolicyDiagnostics();
  const initial = d.checkpoint();
  for (let i = 0; i < 50000; i++)
    d.record({ origin: "https://assets.invalid", reason: "origin_not_allowed" });
  assert.equal(d.entries.size, 1);
  assert.equal(d.since(initial)[0].count, 50000);
  const next = d.checkpoint();
  d.record({ origin: "https://assets.invalid", reason: "origin_not_allowed" });
  assert.equal(d.since(next)[0].count, 1);
  for (let i = 0; i < 10000; i++)
    d.record({ origin: "https://host" + i + ".invalid", reason: "origin_not_allowed" });
  assert.equal(d.entries.size, 64);
  assert.equal(d.since(next).at(-1).count, 9937);
  assert.ok(JSON.stringify(d.since(initial)).length < 15000);
});
