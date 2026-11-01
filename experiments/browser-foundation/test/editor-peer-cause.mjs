// Real collaborative-editor counterexamples plus a composition of the official
// tools. Fixture APIs seed unique documents only; edits and persistence use UI.
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const inputs = JSON.parse(await readFile("/inputs.json", "utf8")).nextcloud;
const root = "/results/editor-peer-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const selector = "[role=dialog] [contenteditable=true]";
const text = (el) =>
  el.evaluate((e) => {
    const c = e.cloneNode(true);
    for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
    return c.textContent;
  });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const rows = [];
try {
  for (const strategy of ["focused-arrow-bulk", "focused-arrow-keys", "focused-home-keys"])
    for (const first of ["ASCII", "日本語"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      let client, server;
      const name = "Cause 1031 Peer " + strategy + " " + first + " " + Date.now() + ".txt";
      const initial = "Existing collaborative document\n";
      const seed = await fetch(
        "http://nextcloud/remote.php/dav/files/" + inputs.username + "/" + encodeURIComponent(name),
        {
          method: "PUT",
          headers: {
            authorization:
              "Basic " + Buffer.from(inputs.username + ":" + inputs.password).toString("base64"),
            "content-type": "text/plain",
          },
          body: initial,
        },
      );
      if (seed.status !== 201) throw new Error("Unique fixture seed failed");
      const page = await context.newPage();
      await page.goto("http://nextcloud/login");
      await page
        .getByRole("textbox", { name: "Account name or email", exact: true })
        .fill(inputs.username);
      await page.getByRole("textbox", { name: "Password", exact: true }).fill(inputs.password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.goto("http://nextcloud/apps/files/files");
      await page.getByRole("button", { name: "View: " + name, exact: true }).click();
      await page.locator(selector + " code").waitFor({ state: "attached" });
      await page.waitForTimeout(1000);
      const peer = await context.newPage();
      await peer.goto(page.url(), { waitUntil: "domcontentloaded" });
      await peer.locator(selector).waitFor();
      await peer.waitForTimeout(1000);
      await peer.locator(selector).click();
      await page.waitForTimeout(500);
      const before = await text(page.locator(selector));
      if (before !== initial && before !== initial.trimEnd())
        throw new Error("Invalid collaborative baseline");
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
      client = new Client({ name: "isolated-text-intent-prototype", version: "baseline" });
      await client.connect(a);
      const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        if (r.isError) throw new Error("Official tool failed: " + name);
        return r;
      };
      await call("browser_snapshot", {}); // Initialize the supplied-context getter.
      await call("browser_tabs", { action: "select", index: 0 });
      const expected = first + " replacement\n\nCafé 日本語 😀";
      const start = Date.now();
      let error;
      try {
        if (strategy === "upstream-fill")
          await call("browser_type", { target: selector, text: expected });
        else {
          await call("browser_click", { target: selector });
          await call("browser_press_key", { key: "ControlOrMeta+A" });
          await call("browser_press_key", { key: "Backspace" });
          await call("browser_press_key", {
            key: strategy.includes("home") ? "Home" : "ArrowRight",
          });
          if (strategy.endsWith("keys")) await page.keyboard.type(expected);
          else await page.keyboard.insertText(expected);
        }
      } catch (e) {
        error = e.message;
      }
      const inputMs = Date.now() - start;
      await page.waitForTimeout(500);
      const actual = await text(page.locator(selector));
      let peerConverged = false;
      try {
        await peer.waitForFunction(
          ({ selector, value }) => {
            const e = document.querySelector(selector);
            if (!e) return false;
            const c = e.cloneNode(true);
            for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
            return c.textContent === value;
          },
          { selector, value: actual },
          { timeout: 12000 },
        );
        peerConverged = true;
      } catch {}
      const peerActual = await text(peer.locator(selector));
      await call("browser_click", { target: 'role=button[name="Save document"]' });
      await page.waitForTimeout(1000);
      await call("browser_click", { target: '[role=dialog] >> role=button[name="Close"s]' });
      await page.getByRole("button", { name: "View: " + name, exact: true }).click();
      await page.locator(selector).waitFor();
      await page.waitForTimeout(1500);
      const persisted = await text(page.locator(selector));
      const widgets = await page.locator(selector + " [contenteditable=false]").count();
      await page.screenshot({ path: root + "/" + strategy + "-" + first + ".png" });
      const row = {
        strategy,
        first,
        name,
        before,
        expected,
        actual,
        peerActual,
        peerConverged,
        persisted,
        widgets,
        inputMs,
        error,
        passed: !error && actual === expected && peerActual === expected && persisted === expected,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await client.close();
      await server.close();
      await context.close();
    }
} finally {
  await browser.close();
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, cases: rows.length }));
}
