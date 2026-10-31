// Audit receipts, not product behavior. Intentional failures must stay failures.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root = process.argv[2];
assert(root, "Pass the private experiment evidence root");
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url), "utf8"),
  runtimeHash = createHash("sha256").update(source).digest("hex");
assert(
  !/nextcloud|grafana|odoo|hedgedoc|etherpad|wordpress|nodered|CodeMirror|monaco|ProseMirror/i.test(
    source,
  ),
  "Shared engine must not contain app-specific routing",
);
const dirs = (await readdir(root)).sort().reverse();
async function select(prefix, predicate = () => true) {
  for (const dir of dirs.filter((d) => d.startsWith(prefix))) {
    let value;
    try {
      value = JSON.parse(await readFile(path.join(root, dir, "results.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (value.runtimeHash === runtimeHash && predicate(value)) return { dir, value };
  }
  throw Error("No matching final receipt: " + prefix);
}
const controls = await select("decisive-controls-");
assert.equal(controls.value.rows.length, 69);
const plain = [
  "input",
  "textarea",
  "controlled",
  "nested-editable",
  "iframe",
  "shadow",
  "replace-on-focus",
  "editing-island",
  "trailing-empty-blocks",
  "edit-context",
  "edit-context-scope",
];
for (const row of controls.value.rows) {
  assert.equal(row.falseAcceptance, false);
  assert.equal(row.wrongTarget, false);
  let status;
  if (plain.includes(row.kind)) status = "accepted";
  else if (
    [
      "readonly",
      "disabled",
      "ambiguous",
      "edit-context-readonly",
      "edit-context-disabled",
    ].includes(row.kind)
  )
    status = "not-dispatched";
  else if (row.kind === "steal-on-select") status = "unknown";
  else if (row.kind === "copy-denied") status = "unverified";
  else if (row.kind === "uppercase") status = "mismatch";
  else if (row.kind === "reject-paste")
    status = row.strategy === "native-control-keyboard" ? "accepted" : "mismatch";
  else if (row.kind === "proxy-editor")
    status = row.strategy === "native-control-keyboard" ? "mismatch" : "accepted";
  else if (row.kind === "noneditable-widget")
    status = row.strategy === "native-control-scope" ? "accepted" : "unknown";
  else if (row.kind === "rollback") {
    status = "accepted";
    assert.equal(row.laterMismatch, true);
  } else throw Error("Unclassified control " + row.kind);
  assert.equal(row.result.status, status, row.kind + " / " + row.strategy);
}
const training = await select("decisive-training-", (v) => v.rows.length === 3);
assert.deepEqual(
  training.value.rows.map((r) => r.app),
  ["nextcloud", "grafana", "odoo"],
);
for (const row of training.value.rows) {
  assert.equal(row.passed, true);
  assert.equal(row.edits.length, 2);
  assert(row.edits.every((e) => e.status === "accepted"));
  assert.equal(row.persisted, row.expected);
  if (row.app === "nextcloud") assert.equal(row.peer, row.expected);
}
const rich = [];
for (const app of ["wordpress", "hedgedoc"]) {
  const r = await select(
    "decisive-rich-regressions-",
    (v) => v.rows.length === 1 && v.rows[0].app === app,
  );
  assert.equal(r.value.rows[0].passed, true);
  assert(r.value.rows[0].edits.every((e) => e.status === "accepted"));
  rich.push(r);
}
const etherpad = await select("decisive-etherpad-comparison-", (v) => v.rows.length === 1);
const ep = etherpad.value.rows[0];
assert.equal(ep.passed, true);
assert.equal(ep.edits.length, 2);
for (const edit of ep.edits) {
  assert.equal(edit.result.status, "accepted");
  assert.equal(edit.peer, edit.expected);
}
assert.equal(ep.persisted, ep.edits.at(-1).expected);
const nodered = await select("decisive-nodered-audit-");
assert.equal(nodered.value.passed, true);
assert.equal(nodered.value.nativeEditContextReceiver, true);
assert.equal(nodered.value.actual, nodered.value.expected);
const post = await select("decisive-postconditions-");
assert.equal(post.value.rows.length, 6);
const cases = Object.fromEntries(post.value.rows.map((r) => [r.id, r]));
for (const id of ["hydration-no-ready", "rollback-no-assert"])
  assert.equal(cases[id].testOutcome, "failed_persisted_readback");
assert.equal(cases["rollback-asserted"].testOutcome, "failed_expected_condition");
assert.equal(cases["rollback-asserted"].saveCount, 0);
for (const id of ["hydration-ready", "uppercase-explicit", "slow"]) {
  assert.equal(cases[id].testOutcome, "passed");
  assert.equal(cases[id].saveCount, 1);
}
assert(cases.slow.actionError.includes("Timeout"));
const batch = await select("decisive-final-batch-");
assert.equal(batch.value.clipboardIsolation.passed, true);
assert.equal(batch.value.clipboardIsolation.distinctDisplays, true);
assert(batch.value.jobs.every((j) => j.exit === 0));
const summary = {
  runtimeHash,
  controlCases: 69,
  immediateFalseAcceptances: 0,
  wrongTargetWrites: 0,
  delayedRollbackCounterexamples: 3,
  realAppsWithSupportedPersistedJourney: 7,
  postconditionCases: 6,
  intentionalBusinessFailures: 3,
  clipboardIsolation: true,
  receipts: [
    controls.dir,
    training.dir,
    ...rich.map((r) => r.dir),
    etherpad.dir,
    nodered.dir,
    post.dir,
    batch.dir,
  ],
  conclusion:
    "isolated subsystem direction supported; not activation or complete integration qualification",
};
await writeFile(path.join(root, "decisive-evidence-audit.json"), JSON.stringify(summary, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(summary, null, 2));
