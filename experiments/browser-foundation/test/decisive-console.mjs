// Operator apparatus for fictional real-app fixtures. The shared input engine
// stays separate and unchanged; no editor model or business API mutation exists.
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import readline from "node:readline";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const root = "/results/decisive-live-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
let inputs;
try {
  inputs = JSON.parse(await readFile("/results/decisive-private-inputs.json", "utf8"));
} catch {
  inputs = {
    wordpress: {
      username: "experiment-admin",
      password: randomBytes(24).toString("base64url"),
      email: "experiment@example.invalid",
    },
  };
  await writeFile("/results/decisive-private-inputs.json", JSON.stringify(inputs), { mode: 0o600 });
}
try {
  inputs = { ...JSON.parse(await readFile("/inputs.json", "utf8")), ...inputs };
} catch {}
const safe = (v) => {
  let s = JSON.stringify(v);
  for (const x of Object.values(inputs))
    if (x.password) s = s.replaceAll(x.password, "[FIXTURE_SECRET]");
  return JSON.parse(s);
};
const hash = createHash("sha256")
  .update(await readFile(new URL("./decisive-runtime.mjs", import.meta.url)))
  .digest("hex");
await writeFile(
  root + "/runtime-source.mjs",
  await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  { mode: 0o600 },
);
const env = await privateBrowser();
let context,
  page,
  runtime,
  seq = 0;
async function fresh() {
  await runtime?.close();
  await context?.close();
  context = await env.browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: root + "/video" },
  });
  page = await context.newPage();
  const source = await readFile("/workspace/packages/veil/src/native-mask-runtime.js", "utf8");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: source + "\ninstallNativeMasks([]);",
    worldName: "scry-native-protection",
    runImmediately: true,
  });
  runtime = await sharedRuntime(context, env.clipboard);
  return { fresh: true };
}
await fresh();
const snapshot = async () => ({
  url: page.url(),
  snapshot: await page.locator("body").ariaSnapshot(),
});
async function run(c) {
  if (c.op === "fresh") return fresh();
  if (c.op === "goto") {
    const u = new URL(c.url);
    if (
      ![
        "http://scry-decisive-wordpress",
        "http://scry-decisive-hedgedoc:3000",
        "http://scry-decisive-etherpad:9001",
        "http://scry-decisive-nodered:1880",
        "http://nextcloud",
        "http://grafana:3000",
        "http://odoo:8069",
      ].includes(u.origin)
    )
      throw Error("Not an approved lab target");
    await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    return snapshot();
  }
  if (c.op === "snapshot") return snapshot();
  if (c.op === "click") {
    await page.locator(c.target).click({ timeout: 12000 });
    return snapshot();
  }
  if (c.op === "bootstrap-fill") {
    const text = c.secret
      ? inputs[c.secret].password
      : c.username
        ? inputs[c.username].username
        : c.text;
    await page.locator(c.target).fill(text);
    return { filled: true };
  }
  if (c.op === "replace") {
    const result = await runtime.replace({
      page,
      target: c.target,
      text: c.text,
      strategy: c.strategy ?? "guarded-native-paste",
    });
    return { runtimeHash: hash, result, ...(await snapshot()) };
  }
  if (c.op === "read")
    return {
      url: page.url(),
      values: await page.locator(c.target).evaluateAll(
        (es, includeHtml) =>
          es.map((e) => ({
            tag: e.tagName,
            role: e.getAttribute("role"),
            label: e.getAttribute("aria-label"),
            placeholder: e.getAttribute("placeholder"),
            value: e.matches("input,textarea") ? e.value : e.innerText,
            html: includeHtml ? e.outerHTML : undefined,
          })),
        c.html ?? false,
      ),
      snapshot: c.snapshot ? await page.locator("body").ariaSnapshot() : undefined,
    };
  if (c.op === "screenshot") {
    const file = root + "/" + ++seq + ".png";
    await page.screenshot({ path: file });
    return { file };
  }
  if (c.op === "tool") return runtime.call(c.name, c.args ?? {});
  if (c.op === "wait") {
    await page.waitForTimeout(Math.min(c.ms, 2000));
    return snapshot();
  }
  throw Error("Unknown apparatus operation");
}
const lines = readline.createInterface({ input: process.stdin, terminal: false });
console.log(JSON.stringify({ root, runtimeHash: hash, ready: true }));
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (c.op === "quit") break;
    try {
      const result = safe(await run(c));
      await appendFile(
        root + "/ledger.jsonl",
        JSON.stringify({ at: new Date().toISOString(), command: c, result }) + "\n",
        { mode: 0o600 },
      );
      const s = JSON.stringify(result);
      console.log(
        s.length > 14000 ? s.slice(0, 14000) + " [display truncated; full result retained]" : s,
      );
    } catch (e) {
      const result = safe({ error: e.message });
      await appendFile(root + "/ledger.jsonl", JSON.stringify({ command: c, result }) + "\n", {
        mode: 0o600,
      });
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await runtime?.close();
  await context?.close();
  await env.close();
  lines.close();
}
