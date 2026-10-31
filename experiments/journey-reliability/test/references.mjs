import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { privateBrowser, sharedRuntime } from "../../browser-foundation/test/decisive-runtime.mjs";
import { DocumentBindings } from "./reference-binding.mjs";
import { preparePointer } from "./pointer-preflight.mjs";
const root = "/results/journey-references-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const sources = {};
for (const f of ["reference-binding.mjs", "references.mjs", "pointer-preflight.mjs"]) {
  const s = await readFile(new URL(f, import.meta.url));
  sources[f] = createHash("sha256").update(s).digest("hex");
  await writeFile(root + "/" + f, s, { mode: 0o600 });
}
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    req.url === "/frame"
      ? "<label>Frame text<input value=frame></label>"
      : `<!doctype html><h1>Native reference fixture</h1><label>Main text<input id=main value=original></label><label>Unrelated<input id=decoy value=untouched></label><div id=shadow></div><iframe src=/frame title=Text-frame></iframe><script>const h=document.querySelector('#shadow').attachShadow({mode:'open'});h.innerHTML='<label>Shadow text<input value=shadow></label>';</script>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const env = await privateBrowser(),
  context = await env.browser.newContext({ viewport: { width: 1280, height: 720 } }),
  page = await context.newPage(),
  bindings = new DocumentBindings(context);
let rt;
const rows = [];
const snapshot = async () => {
  const r = await rt.call("browser_snapshot", {});
  return r.content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");
};
const ref = (text, label) => {
  const line = text.split("\n").find((s) => s.includes('textbox "' + label + '"'));
  const r = /\[ref=((?:f\d+)?e\d+)\]/.exec(line ?? "");
  if (!r) throw Error("No observed reference for " + label);
  return r[1];
};
async function test(name, fn) {
  try {
    const detail = await fn();
    rows.push({ name, passed: true, detail });
  } catch (e) {
    rows.push({ name, passed: false, error: e.message });
  }
  console.log(JSON.stringify(rows.at(-1)));
}
try {
  await page.goto(origin);
  rt = await sharedRuntime(context, env.clipboard);
  let s = await snapshot();
  for (const [label, expected] of [
    ["Main text", "Native ordinary reference"],
    ["Shadow text", "Native shadow reference"],
    ["Frame text", "Native frame reference"],
  ])
    await test("replace_through_" + label.replaceAll(" ", "_"), async () => {
      s = await snapshot();
      const b = await bindings.bind(page, ref(s, label));
      try {
        assert.equal(await b.valid(), true);
        assert.equal((await preparePointer(b.locator)).ready, true);
        const r = await rt.replace({
          page,
          target: b.selector,
          text: expected,
          strategy: "native-control-scope",
        });
        assert.equal(r.status, "accepted");
        assert.equal(await b.handle.evaluate((e) => e.value), expected);
        assert.equal(await page.locator("#decoy").inputValue(), "untouched");
        return { reference: ref(s, label), status: r.status };
      } finally {
        await b.dispose();
      }
    });
  await test("removed_element_invalidates_bound_reference", async () => {
    s = await snapshot();
    const b = await bindings.bind(page, ref(s, "Main text"));
    await page.locator("#main").evaluate((e) => e.replaceWith(e.cloneNode()));
    assert.equal(await b.valid(), false);
    await b.dispose();
  });
  await test("same_url_navigation_invalidates_binding", async () => {
    s = await snapshot();
    const b = await bindings.bind(page, ref(s, "Main text"));
    await page.reload();
    assert.equal(await b.valid(), false);
    await b.dispose();
  });
  await test("new_tab_navigation_is_observed", async () => {
    const p = await context.newPage();
    await p.goto(origin);
    await rt.call("browser_tabs", { action: "select", index: context.pages().indexOf(p) });
    const s = await snapshot(),
      b = await bindings.bind(p, ref(s, "Main text"));
    await p.reload();
    assert.equal(await b.valid(), false);
    await b.dispose();
    await p.close();
    await rt.call("browser_tabs", { action: "select", index: 0 });
  });
  await test("reference_cannot_be_used_as_selector_injection", async () => {
    await assert.rejects(bindings.bind(page, "e1 >> #decoy"), /INVALID_NATIVE_REFERENCE/);
  });
  await test("reference_from_other_tab_is_not_silently_rebound", async () => {
    s = await snapshot();
    const old = ref(s, "Main text"),
      p = await context.newPage();
    await p.goto(origin);
    await rt.call("browser_tabs", { action: "select", index: context.pages().indexOf(p) });
    await snapshot();
    let failed = false;
    try {
      const b = await bindings.bind(p, old);
      await b.dispose();
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(await p.locator("#main").inputValue(), "original");
    await p.close();
    await rt.call("browser_tabs", { action: "select", index: 0 });
  });
} finally {
  await rt?.close();
  await context.close();
  await env.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    root + "/results.json",
    JSON.stringify(
      { root, sources, kind: "pinned_native_reference_contract_not_blind_acceptance", rows },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ root, cases: rows.length, passed: rows.filter((x) => x.passed).length }),
  );
}
