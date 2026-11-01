// Isolated comparison of trusted native paste with input primitives. Clipboard
// writes use a private localhost helper, not the application's DOM/editor API.
// No application security flags or broad clipboard permissions are changed.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).nextcloud;
const root = "/results/editor-native-paste-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const selector = "[role=dialog] [contenteditable=true]";
const rows = [];
const helper = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end("<!doctype html><title>Isolated clipboard helper</title>");
});
await new Promise((resolve) => helper.listen(0, "127.0.0.1", resolve));
const helperOrigin = "http://127.0.0.1:" + helper.address().port;
const headed = process.env.SCRY_CAUSE_HEADED === "true";
const masks = process.env.SCRY_CAUSE_MASKS === "true";
const display = headed
  ? spawn("Xvfb", [":91", "-screen", "0", "1320x820x24", "-nolisten", "tcp"], { stdio: "ignore" })
  : undefined;
if (display) await new Promise((resolve) => setTimeout(resolve, 300));
const browser = await chromium.launch({
  headless: !headed,
  args: ["--no-sandbox"],
  env: { ...process.env, ...(headed ? { DISPLAY: ":91" } : {}) },
});
const maskSource = masks
  ? await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8")
  : null;
async function install(page) {
  if (!maskSource) return;
  const session = await page.context().newCDPSession(page);
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: maskSource + "\ninstallNativeMasks([]);",
    worldName: "scry-native-protection",
    runImmediately: true,
  });
}
const text = (el) =>
  el.evaluate((e) => {
    const c = e.cloneNode(true);
    for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
    return c.textContent;
  });
const inspect = (page) =>
  page.locator(selector).evaluate((e) => {
    const s = document.getSelection();
    const path = (node) => {
      const nodes = [];
      while (node && node !== e) {
        nodes.unshift(node.nodeName);
        node = node.parentNode;
      }
      return { inside: node === e, nodes };
    };
    return {
      focused: document.hasFocus(),
      active: document.activeElement === e,
      visibility: document.visibilityState,
      html: e.innerHTML,
      anchor: s ? { ...path(s.anchorNode), offset: s.anchorOffset } : null,
      focus: s ? { ...path(s.focusNode), offset: s.focusOffset } : null,
      events: globalThis.__pasteProbe ?? [],
    };
  });
async function waitText(page, expected, timeout = 12000) {
  try {
    await page.waitForFunction(
      ({ selector, expected }) => {
        const e = document.querySelector(selector);
        if (!e) return false;
        const c = e.cloneNode(true);
        for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
        return c.textContent === expected;
      },
      { selector, expected },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}
try {
  for (const strategy of process.env.SCRY_CAUSE_STRATEGY
    ? [process.env.SCRY_CAUSE_STRATEGY]
    : ["native-paste", "clear-native-paste", "arrow-keys", "upstream-fill"])
    for (const first of ["ASCII", "日本語"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      let client, server, clipboard;
      try {
        const name = `Cause 1031 Native ${strategy} ${first} ${Date.now()}.txt`;
        const initial = "Existing collaborative document\n";
        const seeded = await fetch(
          "http://nextcloud/remote.php/dav/files/" +
            input.username +
            "/" +
            encodeURIComponent(name),
          {
            method: "PUT",
            headers: {
              authorization:
                "Basic " + Buffer.from(input.username + ":" + input.password).toString("base64"),
              "content-type": "text/plain",
            },
            body: initial,
          },
        );
        if (seeded.status !== 201) throw new Error("Unique fictional fixture seed failed");
        const page = await context.newPage();
        await install(page);
        await page.goto("http://nextcloud/login");
        await page
          .getByRole("textbox", { name: "Account name or email", exact: true })
          .fill(input.username);
        await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
        await page.getByRole("button", { name: "Log in", exact: true }).click();
        await page.goto("http://nextcloud/apps/files/files");
        await page.getByRole("button", { name: "View: " + name, exact: true }).click();
        await page.locator(selector + " code").waitFor({ state: "attached" });
        await page.waitForTimeout(1000);
        const peer = await context.newPage();
        await install(peer);
        await peer.goto(page.url(), { waitUntil: "domcontentloaded" });
        await peer.locator(selector).waitFor();
        await peer.waitForTimeout(1000);
        await peer.locator(selector).click();
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: helperOrigin,
        });
        clipboard = await context.newPage();
        await clipboard.goto(helperOrigin);
        server = await createConnection(
          {
            browser: { browserName: "chromium" },
            snapshot: { mode: "none" },
            timeouts: { action: 12000, navigation: 20000, settle: 350, idle: 0 },
          },
          async () => context,
        );
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        client = new Client({ name: "isolated-native-paste", version: "baseline" });
        await client.connect(a);
        const call = async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          if (result.isError) throw new Error("Official tool failed: " + name);
          return result;
        };
        await call("browser_snapshot", {});
        await call("browser_tabs", { action: "select", index: 0 });
        for (let replacement = 0; replacement < 2; replacement++) {
          const expected = `${first} replacement ${replacement}\n\nCafé 日本語 😀`;
          const before = await text(page.locator(selector));
          const focusBefore = await inspect(page);
          await page.locator(selector).evaluate((e) => {
            globalThis.__pasteProbe = [];
            for (const type of ["paste", "beforeinput", "input"])
              e.addEventListener(type, (event) => {
                globalThis.__pasteProbe.push({
                  type,
                  trusted: event.isTrusted,
                  inputType: event.inputType,
                });
              });
          });
          let error, cleared;
          const start = Date.now();
          try {
            if (strategy.includes("paste")) {
              await clipboard.bringToFront();
              await clipboard.evaluate((value) => navigator.clipboard.writeText(value), expected);
              await call("browser_tabs", { action: "select", index: 0 });
            }
            if (strategy === "upstream-fill")
              await call("browser_type", { target: selector, text: expected });
            else {
              await call("browser_click", { target: selector });
              await call("browser_press_key", { key: "ControlOrMeta+A" });
              if (strategy !== "native-paste") {
                await call("browser_press_key", { key: "Backspace" });
                cleared = await inspect(page);
              }
              if (strategy === "arrow-keys") {
                await call("browser_press_key", { key: "ArrowRight" });
                await page.keyboard.type(expected);
              } else await call("browser_press_key", { key: "ControlOrMeta+V" });
            }
          } catch (e) {
            error = e.message;
          }
          const inputMs = Date.now() - start;
          const localConverged = await waitText(page, expected, 3000);
          const actual = await text(page.locator(selector));
          const after = await inspect(page);
          const peerConverged = await waitText(peer, expected);
          const peerActual = await text(peer.locator(selector));
          await call("browser_click", { target: 'role=button[name="Save document"]' });
          await page.waitForTimeout(1000);
          await call("browser_click", { target: '[role=dialog] >> role=button[name="Close"s]' });
          await page.getByRole("button", { name: "View: " + name, exact: true }).click();
          await page.locator(selector + " code").waitFor({ state: "attached" });
          await page.waitForTimeout(1500);
          const persisted = await text(page.locator(selector));
          const row = {
            strategy,
            headed,
            masks,
            first,
            replacement,
            name,
            before,
            expected,
            actual,
            peerActual,
            persisted,
            localConverged,
            peerConverged,
            inputMs,
            error,
            focusBefore,
            cleared,
            after,
            passed:
              !error && actual === expected && peerActual === expected && persisted === expected,
          };
          rows.push(row);
          await appendFile(root + "/cases.jsonl", JSON.stringify(row) + "\n", { mode: 0o600 });
          console.log(
            JSON.stringify({
              strategy,
              first,
              replacement,
              passed: row.passed,
              inputMs,
              error,
              actualLength: actual.length,
            }),
          );
        }
        await page.screenshot({ path: root + "/" + strategy + "-" + first + ".png" });
      } finally {
        if (clipboard && !clipboard.isClosed()) {
          await clipboard.bringToFront().catch(() => {});
          await clipboard.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
        }
        await client?.close();
        await server?.close();
        await context.close();
      }
    }
} finally {
  await browser.close();
  await new Promise((resolve) => helper.close(resolve));
  display?.kill("SIGTERM");
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, cases: rows.length }));
}
