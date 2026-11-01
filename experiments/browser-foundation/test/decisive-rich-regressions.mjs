// Real UI regression journeys for two previously falsifying editors. Their
// fixture selectors and expected business state are not part of the engine.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const require = createRequire("/workspace/packages/praxis/package.json"),
  { expect } = require("playwright-mcp-runtime/test");
const root = "/results/decisive-rich-regressions-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const inputs = JSON.parse(await readFile("/results/decisive-private-inputs.json", "utf8")),
  env = await privateBrowser(),
  rows = [];
const copy = async (page, loc) => {
  await loc.click();
  if (await loc.evaluate((e) => e.isContentEditable))
    await loc.evaluate((e) => {
      const r = e.ownerDocument.createRange();
      r.selectNodeContents(e);
      const s = e.ownerDocument.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
  else await page.keyboard.press("ControlOrMeta+A");
  const sentinel = randomUUID();
  await env.clipboard.write(sentinel);
  await page.keyboard.press("ControlOrMeta+C");
  const actual = await env.clipboard.read();
  return actual === sentinel ? null : actual;
};
async function wordpress(page) {
  await page.goto("http://scry-decisive-wordpress/wp-admin/post.php?post=8&action=edit");
  if (await page.locator("#user_login").count()) {
    await page.locator("#user_login").fill(inputs.wordpress.username);
    await page.locator("#user_pass").fill(inputs.wordpress.password);
    await page.locator("#wp-submit").click();
  }
  await page
    .frameLocator("iframe")
    .getByRole("textbox", { name: "Add title", exact: true })
    .waitFor({ timeout: 20000 });
}
try {
  for (const app of process.env.SCRY_DECISIVE_APPS?.split(",") ?? ["wordpress", "hedgedoc"]) {
    const context = await env.browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: root + "/video" },
      }),
      page = await context.newPage();
    let runtime;
    const row = { app, runtimeHash, edits: [] };
    const title = "Verified WordPress Café 日本語 😀",
      body = "Verified paragraph Café 日本語 😀 — saved draft.",
      markdown = "# Verified holdout\n\nSecond Café 日本語 😀\n\n- Saved task\n- Reviewed result",
      url = "http://scry-decisive-hedgedoc:3000/Cil5EpAjTWmPkXg_ZvAvMA";
    try {
      if (app === "wordpress") await wordpress(page);
      else {
        await page.goto(url);
        await page.getByRole("heading", { name: "Verified holdout", exact: true }).waitFor();
        await page.keyboard.press("Control+Alt+E");
        await page.locator(".CodeMirror").waitFor();
      }
      runtime = await sharedRuntime(context, env.clipboard);
      const fields =
        app === "wordpress"
          ? [
              {
                target: 'iframe >> internal:control=enter-frame >> role=textbox[name="Add title"s]',
                values: ["Keyboard regression title " + Date.now(), title],
              },
              {
                target: "iframe >> internal:control=enter-frame >> p[role=document]",
                values: ["Keyboard regression paragraph " + Date.now(), body],
              },
            ]
          : [
              {
                target: ".CodeMirror",
                values: ["# Keyboard regression " + Date.now() + "\n\nCafé 日本語 😀", markdown],
              },
            ];
      for (const field of fields)
        for (const text of field.values) {
          const result = await runtime.replace({
            page,
            target: field.target,
            text,
            strategy: process.env.SCRY_DECISIVE_STRATEGY ?? "native-control-keyboard",
          });
          row.edits.push(result);
          if (result.status !== "accepted")
            throw Error("Input was not verified: " + result.status + " " + result.reason);
        }
      if (app === "wordpress") {
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible({
          timeout: 20000,
        });
      }
      const peerContext = await env.browser.newContext();
      try {
        const peer = await peerContext.newPage();
        if (app === "wordpress") {
          await wordpress(peer);
          row.persistedTitle = await copy(
            peer,
            peer.frameLocator("iframe").getByRole("textbox", { name: "Add title", exact: true }),
          );
          row.persistedBody = await copy(
            peer,
            peer.frameLocator("iframe").locator("p[role=document]"),
          );
          row.passed = row.persistedTitle === title && row.persistedBody === body;
        } else {
          await peer.goto(url);
          await peer.getByRole("heading", { name: "Verified holdout", exact: true }).waitFor();
          await peer.keyboard.press("Control+Alt+E");
          const editor = peer.locator(".CodeMirror");
          await editor.waitFor();
          await expect
            .poll(
              async () => {
                await editor.click();
                await peer.keyboard.press("ControlOrMeta+A");
                const sentinel = randomUUID();
                await env.clipboard.write(sentinel);
                await peer.keyboard.press("ControlOrMeta+C");
                row.persisted = await env.clipboard.read();
                return row.persisted;
              },
              { timeout: 12000 },
            )
            .toBe(markdown);
          row.passed = true;
        }
        await peer.screenshot({ path: root + "/" + app + ".png" });
      } finally {
        await peerContext.close();
      }
    } catch (e) {
      row.error = e.message;
      row.passed = false;
    } finally {
      await runtime?.close();
      await context.close();
      rows.push(row);
      console.log(JSON.stringify(row));
      await writeFile(
        root + "/results.json",
        JSON.stringify({ root, runtimeHash, rows }, null, 2),
        { mode: 0o600 },
      );
    }
  }
} finally {
  await env.close();
  console.log(JSON.stringify({ root }));
}
