// Characterizes the actual production candidate module, not the lab replacement.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  NativeInteractions,
  privateClipboard,
} from "../../../packages/praxis/src/mcp-native/native-interactions.mjs";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime"),
  { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js"),
  { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const root = "/results/integrated-native-" + Date.now();
await mkdir(root, { recursive: true });
const source = await readFile(
  new URL("../../../packages/praxis/src/mcp-native/native-interactions.mjs", import.meta.url),
);
await writeFile(root + "/executed-native-interactions.mjs", source);
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(
    req.url === "/frame"
      ? "<label>Frame<input value=frame></label>"
      : `<!doctype html><h1>Native candidate</h1><label>Main<input id=main value=original></label><label>Decoy<input id=decoy value=untouched></label><label>Read only<input readonly value=locked></label><div contenteditable=true role=textbox aria-label=Rich id=rich><p>Old text</p></div><div id=shadow></div><iframe src=/frame></iframe><div tabindex=0 role=textbox aria-label=EditContext id=ec></div><script>
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow<input value=shadow></label>';
const e=document.querySelector('#ec');if(window.EditContext){const c=new EditContext({text:'Old context'});e.editContext=c;e.textContent=c.text;c.addEventListener('textupdate',()=>e.textContent=c.text);}
</script>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1320x820x24", "-nolisten", "tcp"], {
  stdio: ["ignore", "ignore", "ignore", "pipe"],
});
const display = await new Promise((resolve, reject) => {
  let s = "";
  xvfb.once("error", reject);
  xvfb.stdio[3].on("data", (b) => {
    s += b;
    if (s.includes("\n")) resolve(":" + s.trim());
  });
});
let browser, context, client, upstream;
const rows = [];
async function check(name, fn) {
  try {
    rows.push({ name, passed: true, detail: await fn() });
  } catch (e) {
    rows.push({ name, passed: false, error: e.message });
  }
  console.log(JSON.stringify(rows.at(-1)));
}
try {
  browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox"],
    env: { ...process.env, DISPLAY: display },
  });
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  upstream = await createConnection(
    {
      browser: { browserName: "chromium" },
      snapshot: { mode: "none" },
      timeouts: { action: 3000, navigation: 6000, settle: 100, idle: 0 },
    },
    async () => context,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await upstream.connect(b);
  client = new Client({ name: "candidate-module-qualification", version: "baseline" });
  await client.connect(a);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw Error(JSON.stringify(r.content));
    return r;
  };
  const interactions = new NativeInteractions(context, call, privateClipboard(display));
  const reference = async (label) => {
    const r = await call("browser_snapshot", {}),
      s = r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      line = s.split("\n").find((s) => s.includes('textbox "' + label + '"'));
    const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
    assert.ok(ref, "Observed reference missing: " + label);
    return ref;
  };
  await check("official_active_page_routing", async () =>
    assert.equal(await interactions.activePage(), page),
  );
  await check("bare_EditContext_does_not_claim_missing_app_shortcuts_work", async () => {
    const r = await interactions.edit({
      target: await reference("EditContext"),
      text: "Bare editor",
      intent: "replace",
      method: "keyboard",
    });
    assert.equal(r.interaction.status, "mismatch");
    assert.equal(
      await page.locator("#ec").evaluate((e) => e.editContext.text),
      "Bare editorOld context",
    );
  });
  // EditContext deliberately delegates selection and clipboard semantics to the
  // application (W3C EditContext). Supply those as ordinary fixture app handlers;
  // the production interaction module must not mutate an app's editor model.
  await page.locator("#ec").evaluate((e) => {
    const c = e.editContext;
    e.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        c.updateSelection(0, c.text.length);
      }
    });
    e.addEventListener("copy", (ev) => {
      ev.preventDefault();
      ev.clipboardData.setData(
        "text/plain",
        c.text.slice(
          Math.min(c.selectionStart, c.selectionEnd),
          Math.max(c.selectionStart, c.selectionEnd),
        ),
      );
    });
    e.addEventListener("paste", (ev) => {
      ev.preventDefault();
      const text = ev.clipboardData.getData("text/plain"),
        a = Math.min(c.selectionStart, c.selectionEnd),
        b = Math.max(c.selectionStart, c.selectionEnd);
      c.updateText(a, b, text);
      c.updateSelection(a + text.length, a + text.length);
      e.textContent = c.text;
    });
  });
  for (const [label, selector] of [
    ["Main", "#main"],
    ["Shadow", "#shadow input"],
    ["Frame", "iframe >> input"],
    ["Rich", "#rich"],
    ["EditContext", "#ec"],
  ])
    for (const method of ["paste", "keyboard"])
      await check("replace_" + label + "_" + method, async () => {
        const text = "Candidate " + label + " " + method,
          target = await reference(label),
          r = await interactions.edit({ target, text, intent: "replace", method });
        const actual =
          label === "Frame"
            ? await page.frameLocator("iframe").locator("input").inputValue()
            : await page
                .locator(selector)
                .evaluate((e) => e.editContext?.text ?? e.value ?? e.innerText);
        assert.equal(
          r.interaction.status,
          "observed",
          JSON.stringify({
            r,
            actual,
            selected: await page
              .locator(selector === "iframe >> input" ? "#main" : selector)
              .evaluate((e) => ({
                start: e.editContext?.selectionStart ?? e.selectionStart,
                end: e.editContext?.selectionEnd ?? e.selectionEnd,
              })),
          }),
        );
        assert.equal(actual, text);
        assert.equal(await page.locator("#decoy").inputValue(), "untouched");
        return r.interaction;
      });
  await check("explicit_insert_not_replacement", async () => {
    const target = await reference("Main");
    await page.locator("#main").evaluate((e) => e.setSelectionRange(0, 0));
    const before = await page.locator("#main").inputValue();
    const r = await interactions.edit({
      target,
      text: "ADD ",
      intent: "insert",
      method: "keyboard",
    });
    assert.equal(r.interaction.status, "observed");
    const after = await page.locator("#main").inputValue();
    assert.equal(after.replace("ADD ", ""), before);
    assert.equal(after.length, before.length + 4);
  });
  await check("read_only_refusal_before_activation", async () => {
    const r = await interactions.edit({
      target: await reference("Read only"),
      text: "No",
      intent: "replace",
      method: "paste",
    });
    assert.equal(r.interaction.status, "not_dispatched");
    assert.equal(r.interaction.inputState, "not_started");
  });
  await check("selector_injection_refused", async () => {
    const r = await interactions.edit({
      target: "e4 >> #decoy",
      text: "No",
      intent: "replace",
      method: "paste",
    });
    assert.equal(r.interaction.status, "not_dispatched");
  });
  await check("focus_steal_never_types_into_decoy", async () => {
    await page
      .locator("#main")
      .evaluate((e) =>
        e.addEventListener("click", () => document.querySelector("#decoy").focus(), { once: true }),
      );
    const r = await interactions.edit({
      target: await reference("Main"),
      text: "Do not write",
      intent: "replace",
      method: "paste",
    });
    assert.equal(r.interaction.status, "unknown");
    assert.equal(r.interaction.inputState, "activation_only");
    assert.equal(await page.locator("#decoy").inputValue(), "untouched");
  });
  await check("replacement_during_activation_is_unknown_without_text_replay", async () => {
    await page
      .locator("#main")
      .evaluate((e) =>
        e.addEventListener("click", () => e.replaceWith(e.cloneNode()), { once: true }),
      );
    const before = await page.locator("#main").inputValue(),
      r = await interactions.edit({
        target: await reference("Main"),
        text: "Do not replay",
        intent: "replace",
        method: "keyboard",
      });
    assert.equal(r.interaction.status, "unknown");
    assert.equal(await page.locator("#main").inputValue(), before);
  });
  await check("copy_denial_cannot_false_verify_old_clipboard", async () => {
    await page
      .locator("#rich")
      .evaluate((e) =>
        e.addEventListener("copy", (event) => event.preventDefault(), { once: true }),
      );
    const r = await interactions.edit({
      target: await reference("Rich"),
      text: "New rich text",
      intent: "replace",
      method: "paste",
    });
    assert.equal(r.interaction.status, "unverified");
    assert.equal(r.interaction.reason, "copy_unavailable");
    assert.equal(await page.locator("#rich").innerText(), "New rich text");
  });
  await check("same_url_reload_invalidates_bound_document", async () => {
    const b = await interactions.bind(page, await reference("Main"));
    try {
      await page.reload();
      assert.equal(await b.valid(), false);
    } finally {
      await b.handle.dispose();
    }
  });
  await check("tab_selection_uses_official_current_tab", async () => {
    const second = await context.newPage();
    await second.goto(origin);
    await call("browser_tabs", { action: "select", index: 1 });
    assert.equal(await interactions.activePage(), second);
    const r = await interactions.edit({
      target: await reference("Main"),
      text: "Second page",
      intent: "replace",
      method: "paste",
    });
    assert.equal(r.interaction.status, "observed");
    assert.equal(await page.locator("#main").inputValue(), "original");
    await second.close();
    await call("browser_tabs", { action: "select", index: 0 });
    assert.equal(await interactions.activePage(), page);
  });
} finally {
  await client?.close().catch(() => {});
  await upstream?.close().catch(() => {});
  await browser?.close().catch(() => {});
  xvfb.kill("SIGTERM");
  await new Promise((r) => server.close(r));
  await writeFile(
    root + "/results.json",
    JSON.stringify(
      {
        kind: "actual_candidate_module_not_blind_or_full_api",
        sourceHash: createHash("sha256").update(source).digest("hex"),
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ root, cases: rows.length, passed: rows.filter((r) => r.passed).length }),
  );
}
if (rows.some((r) => !r.passed)) process.exitCode = 1;
