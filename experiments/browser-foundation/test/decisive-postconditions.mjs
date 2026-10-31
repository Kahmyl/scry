// Falsify immediate field matching as a business-success rule. The same shared
// input engine is combined with ordinary explicit readiness/outcome assertions.
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const root = "/results/decisive-postconditions-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const receipts = {};
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  res.setHeader("content-type", "text/html; charset=utf-8");
  const id = u.searchParams.get("id");
  if (u.pathname === "/save") {
    let body = "";
    for await (const b of req) body += b;
    const val = new URLSearchParams(body).get("value");
    (receipts[id] ??= []).push(val);
    if (id === "slow") await new Promise((r) => setTimeout(r, 8000));
    res.end("<h1>Committed</h1><output>" + val + "</output>");
    return;
  }
  const kind = u.searchParams.get("kind");
  res.end(`<!doctype html><h1>Controlled business form</h1><p id=ready>${kind === "hydration" ? "Loading" : "Ready"}</p><p id=status>Editing</p><form method=POST action="/save?id=${id}" onsubmit="document.querySelector('#submitted').value=window.model"><input id=target aria-label=Target value=old><input type=hidden id=submitted name=value><button ${kind === "hydration" ? "disabled" : ""}>Save once</button></form><script>
 window.model='old';let hydrated=${kind !== "hydration"};const t=document.querySelector('#target'),b=document.querySelector('button');const kind=${JSON.stringify(kind)};
 if(!hydrated)setTimeout(()=>{hydrated=true;t.value='old';document.querySelector('#ready').textContent='Ready';b.disabled=false;},1000);
 t.addEventListener('input',()=>{if(!hydrated)return;window.model=t.value;if(kind==='uppercase'){t.value=t.value.toUpperCase();window.model=t.value;}if(kind==='rollback'){b.disabled=true;setTimeout(()=>{t.value='old';window.model='old';document.querySelector('#status').textContent='Settled';b.disabled=false;},120);}else document.querySelector('#status').textContent='Settled';});</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const env = await privateBrowser();
const rows = [];
const plans = [
  { id: "hydration-no-ready", kind: "hydration", assert: false },
  { id: "hydration-ready", kind: "hydration", ready: "Ready", assert: true },
  { id: "rollback-no-assert", kind: "rollback", assert: false },
  { id: "rollback-asserted", kind: "rollback", settled: "Settled", assert: true },
  { id: "uppercase-explicit", kind: "uppercase", assert: true, expected: "NEW VALUE" },
  { id: "slow", kind: "ordinary", assert: true },
];
try {
  for (const plan of plans) {
    const context = await env.browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    let rt;
    const row = { ...plan };
    try {
      await page.goto(origin + "/?id=" + plan.id + "&kind=" + plan.kind);
      rt = await sharedRuntime(context, env.clipboard);
      if (plan.ready) await rt.call("browser_wait_for", { text: plan.ready });
      row.input = await rt.replace({
        page,
        target: "#target",
        text: "New value",
        strategy: process.env.SCRY_DECISIVE_STRATEGY ?? "native-control-scope",
      });
      if (plan.settled) await rt.call("browser_wait_for", { text: plan.settled });
      const expected = plan.expected ?? "New value";
      row.beforeSave = await page.locator("#target").inputValue();
      row.assertion = plan.assert ? row.beforeSave === expected : null;
      if (plan.assert && row.assertion !== true) {
        row.saveSuppressed = true;
        row.testOutcome = "failed_expected_condition";
      } else {
        try {
          await rt.call("browser_click", { target: "button" });
        } catch (e) {
          row.actionError = e.message.slice(0, 1000);
        }
        await rt.call("browser_wait_for", { text: "Committed" });
        row.persisted = await page.locator("output").innerText();
        row.testOutcome = row.persisted === expected ? "passed" : "failed_persisted_readback";
      }
      row.saveCount = receipts[plan.id]?.length ?? 0;
      console.log(JSON.stringify(row));
    } catch (e) {
      row.error = e.message;
    } finally {
      rows.push(row);
      await rt?.close();
      await context.close();
    }
  }
} finally {
  await env.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    root + "/results.json",
    JSON.stringify({ root, runtimeHash, rows, receipts }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ root, runtimeHash, cases: rows.length }));
}
