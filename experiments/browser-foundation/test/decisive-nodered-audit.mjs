// Independent persisted UI readback, after the measured edit/deploy journey.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { privateBrowser } from "./decisive-runtime.mjs";
const root = "/results/decisive-nodered-audit-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const env = await privateBrowser(),
  context = await env.browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: root + "/video" },
  }),
  page = await context.newPage();
const result = { root, runtimeHash };
try {
  await page.goto("http://scry-decisive-nodered:1880");
  await page.locator("#decisive-function-1031").dblclick();
  const editor = page.locator(".monaco-editor:visible");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  const sentinel = randomUUID();
  await env.clipboard.write(sentinel);
  await page.keyboard.press("ControlOrMeta+C");
  result.actual = await env.clipboard.read();
  result.expected = 'msg.payload = "Verified Café 日本語 😀";\nmsg.checked = true;\nreturn msg;';
  result.passed = result.actual !== sentinel && result.actual === result.expected;
  result.nativeEditContextReceiver = await editor.evaluate((e) => {
    const a = e.ownerDocument.activeElement;
    return e.contains(a) && !!a.editContext;
  });
  await page.screenshot({ path: root + "/persisted.png" });
} catch (e) {
  result.error = e.message;
  result.passed = false;
} finally {
  await context.close();
  await env.close();
  await writeFile(root + "/results.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
