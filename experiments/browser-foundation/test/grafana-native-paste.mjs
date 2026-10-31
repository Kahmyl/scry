// Trusted clipboard sibling check on the research-owned Grafana dashboard.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).grafana;
const root = "/results/grafana-native-paste-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const url =
  "http://grafana:3000/d/ex2bw7t/cause-1031-editor-1018?from=now-6h&to=now&timezone=browser&editPanel=1";
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Private clipboard helper</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const rows = [];
let clipboard;
async function open(context) {
  const page = await context.newPage();
  await page.goto("http://grafana:3000/login");
  await page.getByRole("textbox", { name: "Email or username", exact: true }).fill(input.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL((u) => u.pathname !== "/login");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("textarea.inputarea").waitFor({ state: "attached" });
  return page;
}
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await open(context);
  const editor = page.locator("textarea.inputarea");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  clipboard = await context.newPage();
  await clipboard.goto(origin);
  let expected;
  for (const first of ["ASCII", "日本語"]) {
    expected = first + " native paste replacement\n\nCafé 日本語 😀";
    await clipboard.bringToFront();
    await clipboard.evaluate((value) => navigator.clipboard.writeText(value), expected);
    await page.bringToFront();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+V");
    await page.waitForFunction(
      (value) => document.querySelector("textarea.inputarea")?.value === value,
      expected,
    );
    const actual = await editor.inputValue();
    const rendered = await page.locator(".monaco-editor .view-lines").innerText();
    rows.push({ first, expected, actual, rendered, passed: actual === expected });
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const modal = page.locator('[role="dialog"][aria-modal="true"]');
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await modal.waitFor({ state: "hidden" });
  await page.screenshot({ path: root + "/saved.png" });
  await clipboard.bringToFront();
  await clipboard.evaluate(() => navigator.clipboard.writeText(""));
  await context.close();
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const reopened = await open(fresh);
  const persisted = await reopened.locator("textarea.inputarea").inputValue();
  rows.push({
    check: "independent-login-reopen",
    expected,
    persisted,
    passed: persisted === expected,
  });
  await reopened.screenshot({ path: root + "/reopened.png" });
  await fresh.close();
  console.log(JSON.stringify({ root, rows }));
} finally {
  if (clipboard && !clipboard.isClosed()) {
    await clipboard.bringToFront().catch(() => {});
    await clipboard.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
  }
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
}
