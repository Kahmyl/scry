// Isolated diagnosis only: instrument the pinned adapter and preserved fictional
// applications. No production API/worker/module is modified or hot-reloaded.
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import readline from "node:readline";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { originProxy } = await import("/workspace/packages/praxis/src/mcp-native/proxy.mjs");
const inputs = JSON.parse(await readFile("/inputs.json", "utf8"));
const safe = (value) => {
  let text = JSON.stringify(value);
  for (const v of Object.values(inputs))
    if (v.password) text = text.replaceAll(v.password, "[FICTIONAL_FIXTURE_SECRET]");
  return JSON.parse(text);
};
const root = "/results/cause-lab-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const app = process.env.SCRY_CAUSE_APP ?? "nextcloud";
const origins = {
  nextcloud: "http://nextcloud",
  grafana: "http://grafana:3000",
  odoo: "http://odoo:8069",
  discourse: "http://discourse",
  gitlab: "http://gitlab",
};
if (!origins[app]) throw new Error("Unapproved lab app");
const blocked = [];
const proxy = await originProxy([origins[app]], (event) => blocked.push(event));
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  proxy: { server: proxy.url, bypass: "<-loopback>" },
});
let context,
  page,
  client,
  upstream,
  events = [],
  seq = 0;
async function fresh(masks = false, action = 4000) {
  await client?.close();
  await upstream?.close();
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (masks) {
    const source = await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8");
    context.on("page", async (p) => {
      const session = await context.newCDPSession(p);
      await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: source + "\ninstallNativeMasks([]);",
        worldName: "scry-native-protection",
        runImmediately: true,
      });
    });
  }
  page = await context.newPage();
  await context.exposeBinding("causeEvent", (_source, e) => events.push(e));
  upstream = await createConnection(
    {
      browser: { browserName: "chromium" },
      webmcp: false,
      capabilities: ["core", "vision"],
      imageResponses: "omit",
      outputDir: root,
      snapshot: { mode: "none" },
      timeouts: { action, navigation: 20000, settle: 350, idle: 0 },
    },
    async () => context,
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await upstream.connect(b);
  client = new Client({ name: "isolated-cause-lab", version: "baseline" });
  await client.connect(a);
  await page.goto(origins[app], { waitUntil: "domcontentloaded" });
  return { masks, action, url: page.url(), snapshot: await page.locator("body").ariaSnapshot() };
}
async function execute(c) {
  page = context?.pages().at(-1) ?? page;
  if (c.op === "fresh") return fresh(c.masks, c.action);
  if (c.op === "call") return client.callTool({ name: c.tool, arguments: c.args ?? {} });
  if (c.op === "snapshot")
    return { url: page.url(), snapshot: await page.locator("body").ariaSnapshot() };
  if (c.op === "login") {
    const names = {
      nextcloud: ["Account name or email", "Password", "Log in"],
      gitlab: ["Username or primary email", "Password", "Sign in"],
    };
    const fields = c.fields ?? names[app];
    if (!fields) throw new Error("Explicit login shape required");
    await page.getByRole("textbox", { name: fields[0], exact: true }).fill(inputs[app].username);
    await page.getByRole("textbox", { name: fields[1], exact: true }).fill(inputs[app].password);
    await page.getByRole("button", { name: fields[2], exact: true }).click({ timeout: 20000 });
    return { url: page.url(), snapshot: await page.locator("body").ariaSnapshot() };
  }
  if (c.op === "inspect")
    return page.evaluate(() => ({
      url: location.href,
      editors: [
        ...document.querySelectorAll("input:not([type=password]),textarea,[contenteditable]"),
      ].map((e) => ({
        tag: e.tagName,
        role: e.getAttribute("role"),
        label: e.getAttribute("aria-label"),
        id: e.id,
        class: e.className,
        contenteditable: e.getAttribute("contenteditable"),
        rect: e.getBoundingClientRect().toJSON(),
      })),
      images: [...document.images].map((e) => ({
        src: e.currentSrc || e.src,
        complete: e.complete,
        width: e.naturalWidth,
      })),
      frames: [...document.querySelectorAll("iframe")].map((e) => ({ src: e.src, title: e.title })),
    }));
  if (c.op === "trace") {
    events = [];
    await page.locator(c.selector).evaluate((e) => {
      for (const name of ["focus", "blur", "keydown", "keyup", "beforeinput", "input", "change"])
        e.addEventListener(name, (event) => {
          const view = e.pmViewDesc?.view;
          const selection = document.getSelection();
          window.causeEvent({
            type: event.type,
            inputType: event.inputType,
            data: event.data,
            key: event.key,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
            text: e.textContent,
            model: view?.state.doc.textContent,
            modelSelection: view
              ? { from: view.state.selection.from, to: view.state.selection.to }
              : undefined,
            domSelection: selection
              ? {
                  anchor: selection.anchorOffset,
                  focus: selection.focusOffset,
                  text: selection.toString(),
                }
              : undefined,
            value: e.tagName === "INPUT" || e.tagName === "TEXTAREA" ? e.value : undefined,
            at: performance.now(),
          });
        });
    });
    return { tracing: true };
  }
  if (c.op === "input") {
    events = [];
    const locator = page.locator(c.selector);
    const started = Date.now();
    let error;
    try {
      if (c.method === "fill") await locator.fill(c.text);
      else if (c.method === "keys") await locator.pressSequentially(c.text);
      else if (c.method === "replace-keys") {
        await locator.press("ControlOrMeta+A");
        await locator.pressSequentially(c.text);
      } else if (c.method === "replace-insert") {
        await locator.press("ControlOrMeta+A");
        await page.keyboard.insertText(c.text);
      } else if (c.method === "clear-insert") {
        await locator.press("ControlOrMeta+A");
        await locator.press("Backspace");
        await page.keyboard.insertText(c.text);
      } else if (c.method === "clear-fill") {
        await locator.press("ControlOrMeta+A");
        await locator.press("Backspace");
        await locator.fill(c.text);
      } else if (c.method === "dom-select-insert") {
        await locator.evaluate((e) => {
          e.focus();
          const range = document.createRange();
          range.selectNodeContents(e);
          const s = document.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        });
        if (c.selectionWait) await page.waitForTimeout(c.selectionWait);
        await page.keyboard.insertText(c.text);
      } else if (c.method === "insert") await page.keyboard.insertText(c.text);
      else if (c.method === "press") await locator.press(c.key);
      else throw new Error("Unknown method");
    } catch (e) {
      error = e.message;
    }
    if (c.wait) await page.waitForTimeout(c.wait);
    return {
      method: c.method,
      elapsed: Date.now() - started,
      error,
      text: await locator.textContent(),
      value: await locator.evaluate((e) => e.value ?? null),
      events,
    };
  }
  if (c.op === "read")
    return {
      text: await page.locator(c.selector).textContent(),
      diagnostic: await page.locator(c.selector).evaluate((e) => {
        const v = e.pmViewDesc?.view;
        return {
          html: e.innerHTML,
          pmKeys: Object.keys(e).filter((k) => /pm|tiptap|vue/i.test(k)),
          model: v?.state.doc.toJSON(),
          selection: v ? { from: v.state.selection.from, to: v.state.selection.to } : undefined,
        };
      }),
      events,
      blocked,
    };
  if (c.op === "screenshot") {
    const file = root + "/" + ++seq + ".png";
    await page.screenshot({ path: file });
    return { file };
  }
  if (c.op === "click") {
    await page.locator(c.selector).click({ timeout: c.timeout ?? 20000 });
    return { url: page.url(), snapshot: await page.locator("body").ariaSnapshot() };
  }
  if (c.op === "goto") {
    if (new URL(c.url).origin !== origins[app]) throw new Error("Out of lab scope");
    await page.goto(c.url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), snapshot: await page.locator("body").ariaSnapshot() };
  }
  if (c.op === "wait") {
    await page.waitForTimeout(Math.min(c.ms, 5000));
    return { snapshot: await page.locator("body").ariaSnapshot() };
  }
  if (c.op === "blocked") return blocked;
  throw new Error("Unknown operation");
}
console.log(JSON.stringify({ root, app, ready: true }));
const lines = readline.createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (c.op === "quit") break;
    try {
      const result = safe(await execute(c));
      await appendFile(
        root + "/ledger.jsonl",
        JSON.stringify({ at: new Date().toISOString(), command: c, result }) + "\n",
        { mode: 0o600 },
      );
      const display = JSON.stringify(result);
      console.log(
        display.length > 12000
          ? display.slice(0, 12000) + " [Display truncated; full result in ledger]"
          : display,
      );
    } catch (error) {
      const result = { error: error.message };
      await appendFile(
        root + "/ledger.jsonl",
        JSON.stringify({ at: new Date().toISOString(), command: c, result }) + "\n",
        { mode: 0o600 },
      );
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await context?.close();
  await client?.close();
  await upstream?.close();
  await browser.close();
  await proxy.close();
  lines.close();
}
