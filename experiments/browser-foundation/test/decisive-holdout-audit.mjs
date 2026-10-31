// Independent fresh-session UI audit. This never writes to an editor model or
// issues another text mutation to make a previous result pass.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { privateBrowser } from "./decisive-runtime.mjs";
const require = createRequire("/workspace/packages/praxis/package.json");
const { expect } = require("playwright-mcp-runtime/test");
const root = "/results/decisive-holdout-audit-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url));
const runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const inputs = JSON.parse(await readFile("/results/decisive-private-inputs.json", "utf8"));
const env = await privateBrowser(),
  rows = [];
async function copied(page, target) {
  await target.click();
  if (await target.evaluate((e) => e.isContentEditable))
    await target.evaluate((e) => {
      const d = e.ownerDocument,
        r = d.createRange();
      r.selectNodeContents(e);
      const s = d.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
  else await page.keyboard.press("ControlOrMeta+A");
  const sentinel = randomUUID();
  await env.clipboard.write(sentinel);
  await page.keyboard.press("ControlOrMeta+C");
  const value = await env.clipboard.read();
  if (value === sentinel) throw Error("Copy did not produce an observation");
  return value.replace(/\r\n/g, "\n");
}
for (const app of ["wordpress", "hedgedoc", "etherpad"]) {
  const context = await env.browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: root + "/video" },
    }),
    page = await context.newPage();
  const row = { app, runtimeHash };
  try {
    if (app === "wordpress") {
      await page.goto("http://scry-decisive-wordpress/wp-admin/post.php?post=8&action=edit");
      await page.locator("#user_login").fill(inputs.wordpress.username);
      await page.locator("#user_pass").fill(inputs.wordpress.password);
      await page.locator("#wp-submit").click();
      const frame = page.frameLocator("iframe"),
        title = frame.getByRole("textbox", { name: "Add title", exact: true }),
        body = frame.locator("p[role=document]");
      await expect(title).toHaveText("Verified WordPress Café 日本語 😀", { timeout: 20000 });
      await expect(body).toHaveText("Verified paragraph Café 日本語 😀 — saved draft.");
      row.title = await copied(page, title);
      row.body = await copied(page, body);
      row.passed =
        row.title === "Verified WordPress Café 日本語 😀" &&
        row.body === "Verified paragraph Café 日本語 😀 — saved draft.";
    } else if (app === "hedgedoc") {
      await page.goto("http://scry-decisive-hedgedoc:3000/Cil5EpAjTWmPkXg_ZvAvMA");
      await expect(
        page.getByRole("heading", { name: "Verified holdout", exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await page.keyboard.press("Control+Alt+E");
      const editor = page.locator(".CodeMirror");
      await editor.click();
      const receiver = page.locator("textarea").filter({ visible: true });
      // CodeMirror's hidden keyboard proxy is owned by the clicked editor. Copy
      // operates on its current selection, not a framework document API.
      await page.keyboard.press("ControlOrMeta+A");
      const sentinel = randomUUID();
      await env.clipboard.write(sentinel);
      await page.keyboard.press("ControlOrMeta+C");
      row.copied = await env.clipboard.read();
      row.expected =
        "# Verified holdout\n\nSecond Café 日本語 😀\n\n- Saved task\n- Reviewed result";
      row.passed = row.copied === row.expected;
    } else {
      await page.goto("http://scry-decisive-etherpad:9001/p/Decisive1031Frozen");
      const body = page
        .frameLocator("iframe[name=ace_outer]")
        .frameLocator("iframe[name=ace_inner]")
        .locator("body");
      await expect(body).toContainText("Saved collaborative note", { timeout: 20000 });
      row.copied = await copied(page, body);
      row.expected = "Verified Etherpad\nSecond Café 日本語 😀\nSaved collaborative note";
      row.passed = row.copied === row.expected;
    }
    await page.screenshot({ path: root + "/" + app + ".png" });
  } catch (e) {
    row.error = e.message;
    row.passed = false;
  } finally {
    await context.close();
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
// A second independent browser/display must not observe the first one's native
// clipboard. This tests isolation mechanism, not production cancellation.
const other = await privateBrowser();
try {
  await env.clipboard.write("private-A");
  await other.clipboard.write("private-B");
  rows.push({
    app: "clipboard-isolation",
    passed:
      (await env.clipboard.read()) === "private-A" &&
      (await other.clipboard.read()) === "private-B",
    distinctDisplays: env.display !== other.display,
  });
} finally {
  await other.close();
  await env.close();
}
await writeFile(root + "/results.json", JSON.stringify({ root, runtimeHash, rows }, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify({ root, rows }));
