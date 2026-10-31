import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const root = "/results/navigation-cause-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const counts = {};
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "text/html");
  const u = new URL(req.url, "http://localhost");
  const id = u.searchParams.get("id");
  if (u.pathname === "/save") {
    counts[id] = (counts[id] ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 6000));
    res.writeHead(303, { location: "/result?id=" + id });
    res.end();
  } else if (u.pathname === "/result") res.end("<h1>Saved once</h1>");
  else res.end('<form method="POST" action="/save?id=' + id + '"><button>Save</button></form>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const rows = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  for (const mode of ["current-4s", "bounded-12s", "separate-action-and-commit"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin + "/?id=" + mode);
    let upstream, client;
    const started = Date.now();
    let error, isError, result;
    try {
      if (mode === "separate-action-and-commit") {
        await page
          .getByRole("button", { name: "Save" })
          .click({ timeout: 4000, noWaitAfter: true });
        await page.waitForURL("**/result?*", { waitUntil: "commit", timeout: 12000 });
      } else {
        upstream = await createConnection(
          {
            browser: { browserName: "chromium" },
            snapshot: { mode: "none" },
            timeouts: {
              action: mode === "current-4s" ? 4000 : 12000,
              navigation: 20000,
              settle: 350,
              idle: 0,
            },
          },
          async () => context,
        );
        const [a, b] = InMemoryTransport.createLinkedPair();
        await upstream.connect(b);
        client = new Client({ name: "navigation-cause", version: "baseline" });
        await client.connect(a);
        result = await client.callTool({ name: "browser_click", arguments: { target: "button" } });
        isError = result.isError ?? false;
      }
    } catch (e) {
      error = e.message;
    }
    const resultMs = Date.now() - started;
    await page.waitForURL("**/result?*", { timeout: 15000 }).catch(() => {});
    rows.push({
      mode,
      resultMs,
      isError,
      error,
      dispatchCount: counts[mode] ?? 0,
      finalUrl: page.url(),
      finalText: await page.locator("body").innerText(),
      result,
    });
    console.log(JSON.stringify(rows.at(-1)));
    await client?.close();
    await upstream?.close();
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root }));
}
