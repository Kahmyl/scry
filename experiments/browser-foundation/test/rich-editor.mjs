import { chromium } from "playwright";
import { protector } from "../src/protection.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = "/results/rich-editor-" + Date.now();
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const masks of [false, true]) {
    const context = await browser.newContext();
    if (masks) await context.addInitScript({ content: protector({}).script });
    const page = await context.newPage();
    await page.goto("http://diagnosis:8080/case/controls");
    await page
      .getByRole("textbox", { name: "Work email", exact: true })
      .fill("fictional@example.invalid");
    const editor = page.getByRole("textbox", { name: "Rich editor", exact: true });
    await editor.fill("Rich content works");
    const row = { masks, text: await editor.innerText(), snapshot: await editor.ariaSnapshot() };
    await page.screenshot({ path: root + "/" + masks + ".png" });
    results.push(row);
    assert.equal(row.text, "Rich content works");
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ root, results }));
}
