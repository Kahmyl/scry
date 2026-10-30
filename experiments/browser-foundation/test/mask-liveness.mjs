import { chromium } from "playwright";
import { BestEffortTasks } from "../src/best-effort-tasks.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = "/results/mask-liveness-" + Date.now();
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = {};
try {
  const context = await browser.newContext();
  const background = await context.newPage();
  await background.setContent("<h1>Background application</h1>");
  const active = await context.newPage();
  await active.setContent(
    "<button onclick=\"this.textContent='Active action worked'\">Active action</button>",
  );
  const cdp = await context.newCDPSession(background);
  // Deterministic fault injection: an optional CDP refresh never replies.
  // Lifecycle freezing was tried first but did not stall this Chromium build.
  const stuck = () =>
    cdp.send("Runtime.evaluate", {
      expression:
        "globalThis.__releaseMaskProbe=undefined;new Promise(r=>{globalThis.__releaseMaskProbe=r})",
      awaitPromise: true,
    });
  const original = stuck();
  results.original = await Promise.race([
    original.then(() => "completed"),
    new Promise((r) => setTimeout(() => r("blocked"), 500)),
  ]);
  assert.equal(results.original, "blocked");
  let warnings = 0;
  const bounded = new BestEffortTasks(() => warnings++, 100);
  const start = Date.now();
  await bounded.run([
    [background, () => original],
    [active, async () => {}],
  ]);
  await active.getByRole("button").click({ timeout: 2000 });
  results.bounded = {
    elapsed: Date.now() - start,
    warnings,
    text: await active.getByRole("button").innerText(),
  };
  assert.equal(results.bounded.text, "Active action worked");
  assert.ok(results.bounded.elapsed < 2000);
  await cdp.send("Runtime.evaluate", { expression: "globalThis.__releaseMaskProbe()" });
  await original;
} finally {
  await browser.close();
  await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ root, results }));
}
