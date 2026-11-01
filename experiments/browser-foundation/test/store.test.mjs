import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { protector } from "../src/protection.mjs";

test("durable action IDs deduplicate and conflict, workspace isolates, secrets encrypted", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "scry-store-test-"));
  const store = new Store(root);
  try {
    const run = store.create("a", "env");
    assert.throws(() => store.run(run.id, "b"), /RUN_NOT_FOUND/);
    const first = store.admit(run, "action", "browser_click", { target: "e1" }, { target: "e1" });
    assert.equal(first.replay, false);
    assert.equal(
      store.admit(run, "action", "browser_click", { target: "e1" }, { target: "e1" }).replay,
      true,
    );
    assert.throws(
      () => store.admit(run, "action", "browser_click", { target: "e2" }, { target: "e2" }),
      /ACTION_ID_CONFLICT/,
    );
    store.putSecret("env", "password", "fictional-very-private-123");
    assert.equal(store.secrets("env").password, "fictional-very-private-123");
    assert.deepEqual(store.secrets("other"), {});
    for (const file of ["receipts.sqlite", "receipts.sqlite-wal"])
      assert.equal(
        readFileSync(path.join(root, file)).includes(Buffer.from("fictional-very-private-123")),
        false,
      );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("unfinished action becomes unknown on process recovery, not automatically retried", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "scry-recovery-test-"));
  let store = new Store(root);
  const run = store.create("a", "env");
  store.admit(run, "action", "browser_click", { target: "e1" }, { target: "e1" });
  store.close();
  store = new Store(root);
  try {
    const receipt = store.actions(run.id)[0];
    assert.equal(receipt.execution, "unknown");
    assert.equal(receipt.businessOutcome, "unknown");
    assert.equal(receipt.reason, "parent_restarted");
    assert.equal(store.run(run.id, "a").state, "interrupted");
    assert.equal(
      store.admit(
        store.run(run.id, "a"),
        "action",
        "browser_click",
        { target: "e1" },
        { target: "e1" },
      ).replay,
      true,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("one parent owns local candidate repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "scry-owner-test-"));
  const store = new Store(root);
  try {
    assert.throws(() => new Store(root), /CANDIDATE_OWNER_ALREADY_RUNNING/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("existing Veil classifier preserves ordinary UI text and removes known secrets/cards", () => {
  const p = protector({ password: "fictional-very-private-123" });
  const text = p.clean(
    "Customer Alpha fictional-very-private-123 4111 1111 1111 1111 normal@example.invalid",
  );
  assert.match(text, /Customer Alpha/);
  assert.match(text, /normal@example.invalid/);
  assert.doesNotMatch(text, /fictional-very-private|4111/);
  assert.match(p.script, /background:#000/);
  assert.doesNotMatch(
    p.clean("/logout?requesttoken=fictional-csrf-value&ordinary=visible"),
    /fictional-csrf-value/,
  );
});
