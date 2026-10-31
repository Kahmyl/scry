// Causal controlled fixtures, not blind acceptance or an all-app capability claim.
import { createServer } from "node:http";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { privateBrowser, sharedRuntime } from "../../browser-foundation/test/decisive-runtime.mjs";
import { InteractionLifecycle } from "./lifecycle.mjs";
import { preparePointer } from "./pointer-preflight.mjs";
const require = createRequire("/workspace/packages/praxis/package.json");
const { createConnection } = require("@playwright/mcp"),
  { Client } = require("@modelcontextprotocol/sdk/client/index.js"),
  { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const root = "/results/journey-capability-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const sources = {};
for (const name of ["lifecycle.mjs", "pointer-preflight.mjs", "capability-recovery.mjs"]) {
  const source = await readFile(new URL(name, import.meta.url));
  sources[name] = createHash("sha256").update(source).digest("hex");
  await writeFile(root + "/" + name, source, { mode: 0o600 });
}
const effects = new Map(),
  rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let casePage;
const toolCalls = new Set();
const fixture = `<!doctype html><meta charset=utf-8><style>body{font:18px system-ui;padding:20px}input,button,select{font:inherit;margin:6px}#hoverMenu{display:none}#hover:hover #hoverMenu{display:block}#drag,#drop{width:150px;height:65px;background:#cef;margin:12px}#scroll{height:100px;overflow:auto}#long{height:700px}canvas{border:1px solid}</style>
<h1>Interaction boundary fixture</h1><label>Name<input id=name></label><label><input id=check type=checkbox>Enable test</label><select id=select aria-label=Choice><option>First</option><option>Second</option></select><output id=key></output>
<div id=hover>Open actions<button id=hoverMenu onclick="this.textContent='Menu selected'">Menu action</button></div>
<div draggable=true id=drag ondragstart="event.dataTransfer.setData('text/plain','fictional')">Drag me</div><div id=drop ondragover="event.preventDefault()" ondrop="event.preventDefault();this.dataset.drops=String(Number(this.dataset.drops||0)+1);this.textContent=event.dataTransfer.getData('text/plain')">Drop here</div>
<div id=scroll><div id=long>Scrollable content</div><button id=bottom onclick="this.textContent='Bottom selected'">Bottom action</button></div>
<section id=shadow></section><iframe title=Frame src=/frame></iframe><canvas id=canvas width=200 height=80></canvas>
<button id=popup onclick="window.open('/popup','_blank')">Open popup</button><button id=dialog onclick="document.querySelector('#dialogResult').textContent=confirm('Fictional confirmation')?'Accepted':'Dismissed'">Confirm test</button><output id=dialogResult></output>
<label>Upload fictional file<input type=file id=file onchange="document.querySelector('#fileResult').textContent=this.files[0].name"></label><output id=fileResult></output><a id=download href=/download>Download fictional file</a>
<button id=effect onclick="const token=new window.URL(location).searchParams.get('token');fetch('/effect?token='+token,{method:'POST'}).then(r=>r.text()).then(v=>document.querySelector('#effectResult').textContent=v)">Apply once</button><output id=effectResult>Waiting</output>
<script>const shadowButton=document.createElement('button');shadowButton.id='shadowButton';shadowButton.textContent='Shadow action';shadowButton.onclick=()=>shadowButton.textContent='Shadow selected';document.querySelector('#shadow').attachShadow({mode:'open'}).append(shadowButton);document.querySelector('#name').onkeydown=e=>document.querySelector('#key').textContent=e.key;document.querySelector('#canvas').onclick=()=>document.querySelector('#canvas').dataset.clicked='yes';</script>`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/effect") {
    const token = u.searchParams.get("token");
    effects.set(token, (effects.get(token) ?? 0) + 1);
    await sleep(1200);
    res.end("Applied");
    return;
  }
  if (u.pathname === "/download") {
    res.setHeader("content-disposition", 'attachment; filename="fictional.txt"');
    res.end("Fictional transfer payload");
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    u.pathname === "/frame"
      ? "<button id=frameButton onclick=\"this.textContent='Frame selected'\">Frame action</button>"
      : u.pathname === "/popup"
        ? "<h1>Popup ready</h1>"
        : fixture,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const env = await privateBrowser();
let context, rt;
async function test(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    rows.push({ name, passed: true, elapsedMs: Date.now() - t, detail });
  } catch (e) {
    rows.push({ name, passed: false, elapsedMs: Date.now() - t, error: e.message });
  }
  await writeFile(root + "/progress.json", JSON.stringify({ root, rows }, null, 2), {
    mode: 0o600,
  });
  if (casePage)
    await writeFile(
      root + "/events-" + name + ".json",
      JSON.stringify(await casePage.evaluate(() => window.inputWitness ?? [])),
      { mode: 0o600 },
    ).catch(() => {});
  console.log(JSON.stringify(rows.at(-1)));
}
try {
  context = await env.browser.newContext({
    viewport: { width: 1280, height: 720 },
    acceptDownloads: true,
    recordVideo: { dir: root + "/video" },
  });
  await context.addInitScript(() => {
    window.inputWitness = [];
    for (const type of [
      "mousedown",
      "mouseup",
      "mousemove",
      "dragstart",
      "dragenter",
      "dragover",
      "drop",
      "dragend",
      "click",
      "keydown",
    ])
      document.addEventListener(
        type,
        (e) => {
          inputWitness.push({ type, id: e.target.id, x: e.clientX, y: e.clientY, key: e.key });
          if (inputWitness.length > 200) inputWitness.shift();
        },
        true,
      );
  });
  const page = await context.newPage();
  casePage = page;
  page.on("pageerror", (e) => console.log(JSON.stringify({ fixturePageError: e.message })));
  await page.goto(origin);
  const server = await createConnection(
    {
      browser: { browserName: "chromium" },
      capabilities: ["core", "vision"],
      snapshot: { mode: "none" },
      timeouts: { action: 3000, navigation: 6000, settle: 350, idle: 0 },
    },
    async () => context,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "journey-capability-lab", version: "baseline" });
  await client.connect(a);
  rt = { close: () => client.close() };
  const call = async (name, args) => {
    toolCalls.add(name);
    const result = await client.callTool({ name, arguments: args });
    const logged = structuredClone(result);
    for (const item of logged.content ?? [])
      if (item.type === "image") {
        await writeFile(root + "/mcp-screenshot.png", Buffer.from(item.data, "base64"), {
          mode: 0o600,
        });
        item.bytes = Buffer.byteLength(item.data, "base64");
        delete item.data;
      }
    await appendFile(root + "/calls.jsonl", JSON.stringify({ name, args, result: logged }) + "\n", {
      mode: 0o600,
    });
    if (result.isError)
      throw Error(
        result.content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n"),
      );
    return result;
  };
  await call("browser_snapshot", {});
  await test("form_input", async () => {
    await call("browser_fill_form", {
      fields: [{ target: "#name", name: "Name", type: "textbox", value: "Fictional input" }],
    });
    assert.equal(await page.locator("#name").inputValue(), "Fictional input");
  });
  await test("native_keyboard", async () => {
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "End" });
    assert.equal(await page.locator("#key").innerText(), "End");
  });
  await test("checkbox", async () => {
    await call("browser_fill_form", {
      fields: [{ target: "#check", name: "Enable test", type: "checkbox", value: "true" }],
    });
    assert.equal(await page.locator("#check").isChecked(), true);
  });
  await test("select", async () => {
    await call("browser_select_option", { target: "#select", values: ["Second"] });
    assert.equal(await page.locator("#select").inputValue(), "Second");
  });
  await test("hover_menu", async () => {
    await call("browser_hover", { target: "#hover" });
    await call("browser_click", { target: "#hoverMenu" });
    assert.equal(await page.locator("#hoverMenu").innerText(), "Menu selected");
  });
  if (process.env.SCRY_LAB_HOVER_RESET === "1")
    await test("explicit_close_hover_before_new_pointer_goal", async () => {
      await call("browser_hover", { target: "h1" });
      await page.locator("#hoverMenu").waitFor({ state: "hidden", timeout: 1000 });
    });
  if (process.env.SCRY_LAB_HOVER_RESET === "source")
    await test("generic_source_pointer_preflight", async () => {
      const r = await preparePointer(page.locator("#drag"));
      assert.equal(r.ready, true);
      return r;
    });
  await test("native_drag", async () => {
    await call("browser_drag", { startTarget: "#drag", endTarget: "#drop" });
    assert.equal(await page.locator("#drop").innerText(), "fictional");
  });
  await test("drag_cleanup_restores_following_interaction", async () => {
    await call("browser_press_key", { key: "Escape" });
    await call("browser_mouse_up", {});
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "Home" });
    assert.equal(await page.locator("#key").innerText(), "Home");
  });
  await test("cdp_drag_cancel_restores_following_interaction", async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.cancelDragging");
    await cdp.detach();
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "ArrowLeft" });
    assert.equal(await page.locator("#key").innerText(), "ArrowLeft");
  });
  await test("explicit_native_drag_with_repeated_move", async () => {
    const from = page.locator("#drag"),
      to = page.locator("#drop");
    const before = Number((await to.getAttribute("data-drops")) ?? 0);
    await from.hover();
    await page.mouse.down();
    try {
      await to.hover();
      await to.hover();
    } finally {
      await page.mouse.up();
    }
    assert.equal(await to.innerText(), "fictional");
    assert.equal(Number(await to.getAttribute("data-drops")), before + 1);
  });
  await test("cdp_drag_cancel_after_alternative", async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.cancelDragging");
    await cdp.detach();
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "ArrowRight" });
    assert.equal(await page.locator("#key").innerText(), "ArrowRight");
  });
  await test("nested_scroll_actionability", async () => {
    await call("browser_click", { target: "#bottom" });
    assert.equal(await page.locator("#bottom").innerText(), "Bottom selected");
    assert.ok((await page.locator("#scroll").evaluate((e) => e.scrollTop)) > 0);
  });
  await test("open_shadow_root", async () => {
    await call("browser_click", { target: "#shadow >> #shadowButton" });
    assert.equal(await page.locator("#shadow >> #shadowButton").innerText(), "Shadow selected");
  });
  await test("frame", async () => {
    await call("browser_click", {
      target: "iframe >> internal:control=enter-frame >> #frameButton",
    });
    assert.equal(
      await page.frameLocator("iframe").locator("#frameButton").innerText(),
      "Frame selected",
    );
  });
  await test("coordinate_canvas", async () => {
    await page.locator("#canvas").scrollIntoViewIfNeeded();
    const b = await page.locator("#canvas").boundingBox();
    await call("browser_mouse_click_xy", {
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    });
    assert.equal(await page.locator("#canvas").getAttribute("data-clicked"), "yes");
  });
  await test("popup_and_tab_restore", async () => {
    const p = context.waitForEvent("page", { timeout: 5000 });
    p.catch(() => {});
    await call("browser_click", { target: "#popup" });
    const popup = await p;
    await popup.waitForLoadState();
    assert.equal(await popup.locator("h1").innerText(), "Popup ready");
    await call("browser_tabs", { action: "select", index: 0 });
    await popup.close();
  });
  await test("native_dialog", async () => {
    await call("browser_click", { target: "#dialog" });
    await call("browser_handle_dialog", { accept: false });
    assert.equal(await page.locator("#dialogResult").innerText(), "Dismissed");
  });
  await test("scoped_buffer_upload_mechanics_not_public_contract", async () => {
    await page.locator("#file").setInputFiles({
      name: "fictional.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Fictional upload"),
    });
    assert.equal(await page.locator("#fileResult").innerText(), "fictional.txt");
  });
  await test("download_mechanics_not_public_contract", async () => {
    const pending = page.waitForEvent("download", { timeout: 5000 });
    pending.catch(() => {});
    await call("browser_click", { target: "#download" });
    const d = await pending;
    await d.saveAs(root + "/download.txt");
    assert.equal(await readFile(root + "/download.txt", "utf8"), "Fictional transfer payload");
  });
  await page.screenshot({ path: root + "/capabilities.png", fullPage: true });
  await test("native_type_replaces_explicit_selection", async () => {
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "ControlOrMeta+A" });
    await call("browser_type", {
      target: "#name",
      text: "A separate native input check",
      slowly: true,
    });
    assert.equal(await page.locator("#name").inputValue(), "A separate native input check");
  });
  await test("slow_native_type_inserts_without_implicit_clearing", async () => {
    await call("browser_click", { target: "#name" });
    await call("browser_press_key", { key: "End" });
    await call("browser_type", { target: "#name", text: " plus insertion", slowly: true });
    assert.equal(
      await page.locator("#name").inputValue(),
      "A separate native input check plus insertion",
    );
  });
  await test("coordinate_move_down_up", async () => {
    await page.locator("#canvas").scrollIntoViewIfNeeded();
    const b = await page.locator("#canvas").boundingBox();
    const before = await page.evaluate(
      () => inputWitness.filter((e) => e.type === "click" && e.id === "canvas").length,
    );
    await call("browser_mouse_move_xy", { x: Math.round(b.x + 10), y: Math.round(b.y + 10) });
    await call("browser_mouse_down", {});
    await call("browser_mouse_up", {});
    assert.equal(
      await page.evaluate(
        () => inputWitness.filter((e) => e.type === "click" && e.id === "canvas").length,
      ),
      before + 1,
    );
  });
  await test("coordinate_drag_has_new_drop_effect", async () => {
    assert.equal((await preparePointer(page.locator("#drag"))).ready, true);
    const from = await page.locator("#drag").boundingBox(),
      to = await page.locator("#drop").boundingBox(),
      before = Number(await page.locator("#drop").getAttribute("data-drops"));
    await call("browser_mouse_drag_xy", {
      startX: Math.round(from.x + 30),
      startY: Math.round(from.y + 30),
      endX: Math.round(to.x + 30),
      endY: Math.round(to.y + 30),
    });
    assert.equal(Number(await page.locator("#drop").getAttribute("data-drops")), before + 1);
  });
  await test("wheel_scroll_and_observe", async () => {
    await page.locator("#scroll").scrollIntoViewIfNeeded();
    const b = await page.locator("#scroll").boundingBox();
    await call("browser_mouse_move_xy", {
      x: Math.round(b.x + b.width - 20),
      y: Math.round(b.y + 30),
    });
    await call("browser_mouse_wheel", { deltaX: 0, deltaY: -800 });
    await page.waitForFunction(() => document.querySelector("#scroll").scrollTop === 0, null, {
      timeout: 2000,
    });
  });
  await test("navigation_history_find_and_wait", async () => {
    await call("browser_navigate", { url: origin + "/?checkpoint=first" });
    await call("browser_navigate", { url: origin + "/popup" });
    assert.equal(await page.locator("h1").innerText(), "Popup ready");
    await call("browser_navigate_back", {});
    assert.ok(page.url().includes("checkpoint=first"));
    await call("browser_wait_for", { text: "Interaction boundary fixture" });
    const found = await call("browser_find", { text: "Apply once" });
    assert.ok(found.content.some((c) => c.type === "text" && c.text.includes("Apply once")));
    await call("browser_take_screenshot", {});
  });
  await test("unsafe_retry_control_produces_duplicate", async () => {
    await page.goto(origin + "/?token=unsafe");
    for (let n = 0; n < 2; n++) {
      await call("browser_click", { target: "#effect" });
      try {
        await page.getByText("Applied", { exact: true }).waitFor({ timeout: 30 });
      } catch {}
    }
    await sleep(1300);
    assert.equal(effects.get("unsafe"), 2);
    return { effects: effects.get("unsafe"), expectedFailureDemonstrated: true };
  });
  await test("deadline_does_not_release_inflight_ownership", async () => {
    await page.goto(origin + "/?token=bounded");
    const life = new InteractionLifecycle();
    const spec = {
      id: "save",
      intent: { operation: "save", target: "owned fixture" },
      prepare: async () => true,
      execute: () => call("browser_click", { target: "#effect" }),
      observe: async () => {
        await page.getByText("Applied", { exact: true }).waitFor({ timeout: 2500 });
        return effects.get("bounded") === 1 ? "matched" : "mismatch";
      },
      deadlineMs: 50,
    };
    const first = await life.run(spec);
    assert.equal(first.status, "pending_after_deadline");
    const duplicate = await life.run(spec);
    assert.equal(duplicate.id, "save");
    const busy = await life.run({ ...spec, id: "other" });
    assert.equal(busy.status, "session_busy");
    const settled = await life.settled("save");
    assert.equal(settled.status, "verified");
    assert.equal(first.status, "pending_after_deadline");
    assert.equal(effects.get("bounded"), 1);
    return { first, duplicate, busy, settled, effects: effects.get("bounded") };
  });
  await test("lost_observation_reconciles_without_replay", async () => {
    await page.goto(origin + "/?token=lost");
    const life = new InteractionLifecycle();
    const spec = {
      id: "lost",
      intent: { operation: "apply" },
      prepare: async () => true,
      execute: () => call("browser_click", { target: "#effect" }),
      observe: async () => {
        throw Error("Injected observation loss");
      },
      deadlineMs: 4000,
    };
    const first = await life.run(spec);
    assert.equal(first.status, "needs_inspection");
    await life.run(spec);
    await sleep(1300);
    const final = await life.reconcile("lost", async () =>
      effects.get("lost") === 1 ? "matched" : "inconclusive",
    );
    assert.equal(final.status, "verified");
    assert.equal(effects.get("lost"), 1);
    return { first, final, effects: effects.get("lost") };
  });
  await test("error_after_effect_does_not_mean_failure_or_replay", async () => {
    await page.goto(origin + "/?token=error");
    const life = new InteractionLifecycle();
    const final = await life.run({
      id: "effect",
      intent: { operation: "apply" },
      prepare: async () => true,
      execute: async () => {
        await call("browser_click", { target: "#effect" });
        throw Error("Injected result transport failure");
      },
      observe: async () => {
        await page.getByText("Applied", { exact: true }).waitFor({ timeout: 2500 });
        return effects.get("error") === 1 ? "matched" : "inconclusive";
      },
      deadlineMs: 4000,
    });
    assert.equal(final.execution, "error_after_possible_dispatch");
    assert.equal(final.status, "verified");
    assert.equal(effects.get("error"), 1);
    return final;
  });
  await test("stale_document_rejected_before_dispatch", async () => {
    let epoch = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) epoch++;
    });
    const observed = epoch;
    await page.reload();
    let dispatched = 0;
    const life = new InteractionLifecycle();
    const r = await life.run({
      id: "stale",
      intent: { operation: "click" },
      prepare: async () => epoch === observed,
      execute: async () => dispatched++,
      observe: async () => "matched",
    });
    assert.equal(r.status, "not_dispatched");
    assert.equal(dispatched, 0);
    return r;
  });
  await test("removed_control_rejected_before_dispatch", async () => {
    const handle = await page.locator("#effect").elementHandle();
    await page.reload();
    let dispatched = 0;
    const life = new InteractionLifecycle();
    const r = await life.run({
      id: "removed",
      intent: { operation: "click" },
      prepare: () => handle.evaluate((e) => e.isConnected),
      execute: async () => dispatched++,
      observe: async () => "matched",
    });
    assert.equal(r.status, "not_dispatched");
    assert.equal(dispatched, 0);
    await handle.dispose();
    return r;
  });
  await test("partial_form_failure_is_not_reported_as_not_dispatched", async () => {
    const life = new InteractionLifecycle();
    const r = await life.run({
      id: "partial",
      intent: { operation: "fill" },
      prepare: async () => true,
      execute: () =>
        call("browser_fill_form", {
          fields: [
            { target: "#name", name: "Name", type: "textbox", value: "Partial happened" },
            { target: "#missing", name: "Missing", type: "textbox", value: "Never" },
          ],
        }),
      observe: async () =>
        (await page.locator("#name").inputValue()) === "Partial happened"
          ? "mismatch"
          : "inconclusive",
      deadlineMs: 15000,
    });
    assert.equal(await page.locator("#name").inputValue(), "Partial happened");
    assert.equal(r.dispatched, true);
    assert.equal(r.status, "failed_expected_condition");
    return r;
  });
  await test("same_identity_different_intent_rejected", async () => {
    const life = new InteractionLifecycle();
    const spec = {
      id: "identity",
      intent: { operation: "first" },
      prepare: async () => false,
      execute: async () => {},
      observe: async () => "matched",
    };
    await life.run(spec);
    const r = await life.run({ ...spec, intent: { operation: "different" } });
    assert.equal(r.status, "identity_conflict");
    return r;
  });
  await test("bounded_receipts_never_evict_deduplication_authority", async () => {
    const life = new InteractionLifecycle({ capacity: 4 });
    let actions = 0;
    for (let n = 0; n < 20; n++)
      await life.run({
        id: String(n),
        intent: { operation: "apply" },
        prepare: async () => true,
        execute: async () => actions++,
        observe: async () => "matched",
      });
    assert.equal(actions, 4);
    assert.equal(life.size, 4);
    const duplicate = await life.run({
      id: "0",
      intent: { operation: "apply" },
      prepare: async () => true,
      execute: async () => actions++,
      observe: async () => "matched",
    });
    assert.equal(duplicate.status, "verified");
    assert.equal(actions, 4);
    return { retained: life.size, actions, rejected: 16 };
  });
  await test("every_current_core_vision_tool_called", async () => {
    const contract = await readFile(
        "/workspace/packages/contracts/src/playwright-tool-definitions.ts",
        "utf8",
      ),
      expected = [...contract.matchAll(/name: "(browser_[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      expected.filter((name) => !toolCalls.has(name)),
      [],
    );
    return { publicToolNamesExercised: expected.length, notAClaimOfEveryConfiguration: true };
  });
} finally {
  await rt?.close();
  await context?.close();
  await env.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    root + "/results.json",
    JSON.stringify(
      {
        root,
        sources,
        kind: "controlled_causal_fixture_not_blind_acceptance",
        rows,
        effects: Object.fromEntries(effects),
        toolCalls: [...toolCalls],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      root,
      cases: rows.length,
      passed: rows.filter((r) => r.passed).length,
      failed: rows.filter((r) => !r.passed).map((r) => r.name),
    }),
  );
}
