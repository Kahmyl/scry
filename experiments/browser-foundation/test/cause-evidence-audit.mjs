// Audit causal experiment receipts, not production readiness. Expected failures
// must remain failures; this script never changes their classification.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Absolute private evidence root required");
const checks = [];
async function load(name) {
  return JSON.parse(await readFile(path.join(root, name, "results.json"), "utf8"));
}
async function check(name, verify) {
  const data = await load(name);
  const scopedCount = verify(data.rows);
  checks.push({ experiment: name, cases: scopedCount ?? data.rows.length, preserved: true });
}
await check("editor-matrix-1793442092132", (rows) => {
  assert.equal(rows.length, 32);
  assert.equal(rows.filter((r) => r.strategy === "fill" && !r.passed).length, 8);
  assert.equal(rows.filter((r) => r.strategy !== "fill" && r.passed).length, 24);
});
await check("editor-peer-1793442586713", (rows) => {
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.strategy.includes("arrow") && r.passed).length, 4);
  assert.equal(rows.filter((r) => r.strategy.includes("home") && !r.passed).length, 2);
});
await check("editor-native-paste-1793442793326", (rows) => {
  assert.equal(rows.length, 16);
  assert.equal(rows.filter((r) => r.strategy.includes("paste") && r.passed).length, 8);
  assert.equal(
    rows.filter(
      (r) =>
        r.strategy === "upstream-fill" && r.replacement === 1 && !r.passed && r.persisted === "",
    ).length,
    2,
  );
  assert(
    rows
      .filter((r) => r.strategy.includes("paste"))
      .every((r) => r.after.events.some((e) => e.type === "paste" && e.trusted)),
  );
  assert(rows.every((r) => r.focusBefore.focused && r.focusBefore.active));
});
await check("editor-native-paste-1793443030828", (rows) => {
  assert.equal(rows.length, 4);
  assert(rows.every((r) => r.passed && r.headed && r.masks));
});
await check("grafana-native-paste-1793443134582", (rows) => {
  assert.equal(rows.length, 3);
  assert(rows.every((r) => r.passed));
});
await check("odoo-row-cause-1793443153371", (rows) => {
  assert.equal(rows.length, 4);
  assert(rows.every((r) => !r.changed && r.baselineRestored));
});
await check("odoo-ready-input-1793443263727", (rows) => {
  assert.equal(rows.length, 2);
  assert(rows.every((r) => r.passed));
});
await check("odoo-ready-input-1793443522758", (rows) => {
  assert.equal(rows.length, 1);
  assert(rows[0].passed && rows[0].strategy === "official-click-fill");
});
await check("navigation-cause-1793441430874", (rows) => {
  assert.equal(rows.length, 3);
  assert(rows.every((r) => r.dispatchCount === 1 && r.finalText === "Saved once"));
  assert.equal(rows[0].isError, true);
  assert.equal(rows[1].isError, false);
});
await check("asset-cause-1793441342946", (rows) => {
  const gitlab = rows.filter((r) => r.app === "gitlab");
  assert.equal(gitlab.length, 2);
  assert(gitlab[0].blocked.some((r) => r.reason === "origin_not_allowed"));
  assert(gitlab[1].failed.some((r) => r.failure === "net::ERR_NAME_NOT_RESOLVED"));
  return gitlab.length; // Earlier anonymous Discourse rows are not valid avatar controls.
});
await check("asset-cause-1793442208626", (rows) => {
  assert.equal(rows.length, 2);
  assert(
    rows.every(
      (r) =>
        r.imageCount > 0 && r.blocked.length === 0 && r.responses.some((s) => s.status === 500),
    ),
  );
});
await check("financial-cause-1793441478912", (rows) => {
  assert.equal(rows.length, 21);
  assert(rows.every((r) => r.candidatePassed));
  assert.equal(
    rows.filter(
      (r) => r.text.startsWith("Product EAN:") && r.currentFinancial && !r.candidateFinancial,
    ).length,
    10,
  );
});
await check("financial-context-boundary-1793443525951", (rows) => {
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.broadPassed).length, 1);
  assert(rows.every((r) => r.boundedPassed));
});
const summary = {
  auditedAt: new Date().toISOString(),
  purpose: "causal-receipt-integrity-not-release-qualification",
  activationReady: false,
  checks,
};
await writeFile(path.join(root, "cause-evidence-audit.json"), JSON.stringify(summary, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(summary));
