// Actual Nextcloud journey with injected receipt loss and a new browser context.
// Operator experiment, not blind-agent or integrated Scry acceptance.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { privateBrowser, sharedRuntime } from "../../browser-foundation/test/decisive-runtime.mjs";
import { InteractionLifecycle } from "./lifecycle.mjs";
const root = "/results/journey-real-recovery-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const sources = {};
for (const file of ["lifecycle.mjs", "real-recovery.mjs"]) {
  const s = await readFile(new URL(file, import.meta.url));
  sources[file] = createHash("sha256").update(s).digest("hex");
  await writeFile(root + "/" + file, s, { mode: 0o600 });
}
const input = JSON.parse(await readFile("/inputs.json", "utf8")).nextcloud,
  name = "Recovery journey " + Date.now() + ".txt",
  target = "[contenteditable=true]:has(pre > code)",
  expected =
    "Reliable journey checkpoint\n\nCafé 日本語 😀\nSaved once before the receipt was lost.";
const url =
    "http://nextcloud/remote.php/dav/files/" + input.username + "/" + encodeURIComponent(name),
  headers = {
    authorization: "Basic " + Buffer.from(input.username + ":" + input.password).toString("base64"),
  };
const seeded = await fetch(url, { method: "PUT", headers, body: "Fictional initial checkpoint\n" });
assert.equal(seeded.status, 201);
const env = await privateBrowser(),
  life = new InteractionLifecycle();
let context,
  rt,
  executions = 0;
const result = { root, name, sources, kind: "real_app_operator_recovery_not_blind_acceptance" };
async function login(page) {
  await page.goto("http://nextcloud/login");
  await page
    .getByRole("textbox", { name: "Account name or email", exact: true })
    .fill(input.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}
async function open(page) {
  await page.goto("http://nextcloud/apps/files/files");
  await page.getByText(name, { exact: true }).filter({ visible: true }).first().click();
  await page.locator(target + " code").waitFor();
}
async function persisted() {
  for (let n = 0; n < 20; n++) {
    const r = await fetch(url, { headers });
    if (r.ok && (await r.text()) === expected) return "matched";
    await new Promise((r) => setTimeout(r, 250));
  }
  return "inconclusive";
}
const read = (loc) =>
  loc.evaluate((e) => {
    const c = e.cloneNode(true);
    for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
    return c.textContent;
  });
try {
  context = await env.browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: root + "/video" },
  });
  const page = await context.newPage();
  await login(page);
  await open(page);
  rt = await sharedRuntime(context, env.clipboard);
  const spec = {
    id: "save-checkpoint",
    intent: { operation: "replace_and_save", document: name },
    deadlineMs: 30,
    prepare: async () => (await page.locator(target).count()) === 1,
    execute: async () => {
      executions++;
      const r = await rt.replace({
        page,
        target,
        text: expected,
        strategy: "native-control-scope",
      });
      assert.equal(r.status, "accepted");
      await page.getByRole("button", { name: "Save document", exact: true }).click();
      throw Error("Injected lost tool result after native edit and Save");
    },
    observe: async () => {
      throw Error("Injected lost observation channel");
    },
  };
  result.first = await life.run(spec);
  assert.equal(result.first.status, "pending_after_deadline");
  result.inflightDuplicate = await life.run(spec);
  result.settled = await life.settled(spec.id);
  assert.equal(result.settled.status, "needs_inspection");
  result.reconciled = await life.reconcile(spec.id, persisted);
  assert.equal(result.reconciled.status, "verified");
  await life.run(spec);
  assert.equal(executions, 1);
  result.executions = executions;
  await page.screenshot({ path: root + "/saved-checkpoint.png" });
  const state = await context.storageState();
  await rt.close();
  rt = null;
  await context.close();
  context = await env.browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 720 },
  });
  const restored = await context.newPage();
  await open(restored);
  await restored.waitForFunction(
    ({ target, expected }) => {
      const e = document.querySelector(target);
      if (!e) return false;
      const c = e.cloneNode(true);
      for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
      return c.textContent === expected;
    },
    { target, expected },
    { timeout: 15000 },
  );
  result.newContextReadback = await read(restored.locator(target));
  assert.equal(result.newContextReadback, expected);
  await restored.screenshot({ path: root + "/new-context-restored.png" });
  result.passed = true;
} catch (e) {
  result.passed = false;
  result.error = e.message;
} finally {
  await rt?.close().catch(() => {});
  await context?.close();
  await env.close();
  await writeFile(root + "/results.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
