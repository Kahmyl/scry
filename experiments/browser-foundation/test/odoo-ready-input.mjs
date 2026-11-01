// Business readback on fresh research-only UI duplicates. No original quotation
// is edited. App-owned row activation is observed, never invoked through JS.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const { createConnection } = require("@playwright/mcp");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).odoo;
const root = "/results/odoo-ready-input-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const helper = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Private clipboard helper</title>");
});
await new Promise((resolve) => helper.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + helper.address().port;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const rows = [];
try {
  for (const strategy of process.env.SCRY_ODOO_STRATEGY
    ? [process.env.SCRY_ODOO_STRATEGY]
    : ["ready-fill", "ready-native-paste"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    let clipboard, client, upstream;
    try {
      const page = await context.newPage();
      await page.goto("http://odoo:8069/web/login");
      await page.getByRole("textbox", { name: "Email", exact: true }).fill(input.username);
      await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page.goto("http://odoo:8069/odoo/sales/1");
      await page.getByRole("cell", { name: "3.00", exact: true }).waitFor();
      await page.getByRole("button", { name: "Actions menu", exact: true }).click();
      await page.getByText("Duplicate", { exact: true }).click();
      await page.waitForURL((url) => !url.pathname.endsWith("/sales/1"));
      const researchUrl = page.url();
      if (!/\/sales\/[2-9][0-9]*$/.test(new URL(researchUrl).pathname))
        throw new Error("Not a separate research quotation");
      const note = page.getByRole("textbox", { name: "Enter a description", exact: true });
      const expected = `Cause 1031 ${strategy}: Café 日本語 😀`;
      if (strategy === "ready-native-paste") {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        clipboard = await context.newPage();
        await clipboard.goto(origin);
        await clipboard.evaluate((value) => navigator.clipboard.writeText(value), expected);
        await page.bringToFront();
      }
      await page.getByRole("cell", { name: "3.00", exact: true }).click();
      await page.locator('[name="product_uom_qty"] input').fill("9");
      if (strategy === "official-click-fill") {
        upstream = await createConnection(
          {
            browser: { browserName: "chromium" },
            snapshot: { mode: "none" },
            timeouts: { action: 4000, navigation: 20000, settle: 350, idle: 0 },
          },
          async () => context,
        );
        const [a, b] = InMemoryTransport.createLinkedPair();
        await upstream.connect(b);
        client = new Client({ name: "isolated-official-row-input", version: "baseline" });
        await client.connect(a);
        await client.callTool({ name: "browser_snapshot", arguments: {} });
        for (const [name, args] of [
          ["browser_click", { target: 'role=textbox[name="Enter a description"s]' }],
          ["browser_type", { target: 'role=textbox[name="Enter a description"s]', text: expected }],
        ]) {
          const result = await client.callTool({ name, arguments: args });
          if (result.isError) {
            await writeFile(
              root + "/official-tool-error.json",
              JSON.stringify({ name, result }, null, 2),
              { mode: 0o600 },
            );
            console.log(
              JSON.stringify({
                name,
                error: result.content
                  ?.filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n")
                  .slice(0, 4000),
              }),
            );
            throw new Error("Official tool failed: " + name);
          }
        }
      } else {
        await note.click();
        await page
          .locator('tr.o_selected_row textarea[placeholder="Enter a description"]')
          .waitFor();
        await page.waitForFunction(
          () =>
            document.activeElement ===
            document.querySelector('tr.o_selected_row textarea[placeholder="Enter a description"]'),
        );
        if (strategy === "ready-fill") await note.fill(expected);
        else {
          await note.press("ControlOrMeta+A");
          await note.press("ControlOrMeta+V");
        }
      }
      await page.waitForTimeout(500);
      const actual = await note.inputValue();
      await page.getByRole("button", { name: "Save manually", exact: true }).click();
      await page
        .getByRole("button", { name: "Save manually", exact: true })
        .waitFor({ state: "hidden" });
      await page.reload();
      await note.waitFor();
      await page.getByRole("cell", { name: "9.00", exact: true }).waitFor();
      const persisted = await note.inputValue();
      const row = {
        strategy,
        researchUrl,
        expected,
        actual,
        persisted,
        passed: actual === expected && persisted === expected,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await page.screenshot({ path: root + "/" + strategy + ".png" });
    } finally {
      if (clipboard && !clipboard.isClosed()) {
        await clipboard.bringToFront().catch(() => {});
        await clipboard.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      }
      await client?.close();
      await upstream?.close();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => helper.close(resolve));
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, cases: rows.length }));
}
