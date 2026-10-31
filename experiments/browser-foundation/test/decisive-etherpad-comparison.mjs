// The first Etherpad audit disproved immediate-copy equivalence. Compare
// mechanisms with peer convergence before closing the writing browser.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const require = createRequire("/workspace/packages/praxis/package.json"),
  { expect } = require("playwright-mcp-runtime/test");
const root = "/results/decisive-etherpad-comparison-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const env = await privateBrowser(),
  rows = [];
const target =
  "iframe[name=ace_outer] >> internal:control=enter-frame >> iframe[name=ace_inner] >> internal:control=enter-frame >> body";
async function copy(page) {
  const t = page.locator(target);
  await t.click();
  await page.keyboard.press("ControlOrMeta+A");
  const sentinel = randomUUID();
  await env.clipboard.write(sentinel);
  await page.keyboard.press("ControlOrMeta+C");
  const text = await env.clipboard.read();
  return text === sentinel ? null : text.replace(/\r\n/g, "\n");
}
try {
  for (const strategy of process.env.SCRY_DECISIVE_STRATEGIES?.split(",") ?? [
    "native-control-scope",
    "native-control-scope-all",
  ]) {
    const writer = await env.browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: root + "/video" },
      }),
      peerContext = await env.browser.newContext();
    const page = await writer.newPage(),
      peer = await peerContext.newPage();
    let runtime;
    const row = { strategy, runtimeHash, edits: [] };
    try {
      const url = "http://scry-decisive-etherpad:9001/p/DecisivePeer" + Date.now();
      row.url = url;
      await page.goto(url);
      await page.getByRole("button", { name: "I've saved it", exact: true }).click();
      await page.locator(target).waitFor();
      await peer.goto(url);
      await peer.locator(target).waitFor();
      runtime = await sharedRuntime(writer, env.clipboard);
      for (let n = 0; n < 2; n++) {
        const expected = `Etherpad comparison ${n}\nCafé 日本語 😀\nFinal line`;
        const edit = await runtime.replace({ page, target, text: expected, strategy });
        row.edits.push({ expected, result: edit });
        // Read-only polling records what the independent peer really receives. No
        // trim, model API, fixed success sleep, editor repair or mutation retry.
        await expect
          .poll(
            async () => {
              row.edits.at(-1).peer = await copy(peer);
              return row.edits.at(-1).peer;
            },
            { timeout: 12000, intervals: [200, 400, 800] },
          )
          .toBe(expected);
      }
      await writer.close();
      const fresh = await env.browser.newContext();
      try {
        const p = await fresh.newPage();
        await p.goto(url);
        await p.locator(target).waitFor();
        row.persisted = await copy(p);
        row.passed = row.persisted === row.edits.at(-1).expected;
      } finally {
        await fresh.close();
      }
    } catch (e) {
      row.error = e.message;
      row.passed = false;
      await page.screenshot({ path: root + "/" + strategy + ".png" }).catch(() => {});
    } finally {
      await runtime?.close();
      await writer.close();
      await peerContext.close();
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
