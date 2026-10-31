import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const require = createRequire("/workspace/packages/praxis/package.json");
const { chromium } = require("playwright-mcp-runtime");
const input = JSON.parse(await readFile("/inputs.json", "utf8")).grafana;
const root = "/results/sibling-readback-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("http://grafana:3000/login");
  await page.getByRole("textbox", { name: "Email or username", exact: true }).fill(input.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20000 });
  await page.goto(
    "http://grafana:3000/d/ex2bw7t/cause-1031-editor-1018?from=now-6h&to=now&timezone=browser&editPanel=1",
    { waitUntil: "domcontentloaded" },
  );
  const editor = page.locator("textarea.inputarea");
  await editor.waitFor({ state: "attached", timeout: 20000 });
  await page.waitForTimeout(500);
  const actual = await editor.inputValue();
  const expected = "Cause replacement\nCafé 日本語 😀";
  const row = { app: "grafana", url: page.url(), expected, actual, passed: actual === expected };
  await page.screenshot({ path: root + "/grafana-reopened.png" });
  await writeFile(root + "/results.json", JSON.stringify(row, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, ...row }));
  if (!row.passed) process.exitCode = 1;
} finally {
  await browser.close();
}
