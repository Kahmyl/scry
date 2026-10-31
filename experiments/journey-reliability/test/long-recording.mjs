// Real-app paced soak, not blind acceptance. Existing native capture without a
// time cutoff; bounded storage remains an explicit resource failure, not a split.
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { sharedRuntime } from "../../browser-foundation/test/decisive-runtime.mjs";
import { recording } from "/workspace/packages/praxis/src/mcp-native/recording.mjs";
const require = createRequire("/workspace/packages/praxis/package.json"),
  { chromium } = require("playwright-mcp-runtime"),
  exec = promisify(execFile);
const root = "/results/journey-long-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const i = JSON.parse(await readFile("/inputs.json", "utf8")).nextcloud;
const durationMs = Number(process.env.SCRY_LAB_SOAK_MS ?? 1200000);
if (!Number.isFinite(durationMs) || durationMs < 960000)
  throw Error("Long proof must exceed sixteen minutes");
const capture = await recording(root + "/video", {
  maxBytes: 512 * 1024 * 1024,
  maxMs: Number.POSITIVE_INFINITY,
  capture: { screen: "1320x820x24", size: "1280x720", x: 0, y: 87 },
});
const clipboard = {
  write: (value) =>
    new Promise((resolve, reject) => {
      const p = spawn("xclip", ["-display", capture.display, "-selection", "clipboard", "-in"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      p.once("error", reject);
      p.once("exit", (n) => (n === 0 ? resolve() : reject(Error("Clipboard failed"))));
      p.stdin.end(value);
    }),
  read: async () =>
    (
      await exec("xclip", ["-display", capture.display, "-selection", "clipboard", "-out"], {
        timeout: 1500,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
};
let browser, context, runtime;
const result = {
  root,
  kind: "real_app_paced_soak_not_blind_acceptance",
  durationMs,
  iterations: [],
  recordingPolicy: "continuous_native_no_time_cutoff_bounded_storage",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (loc) =>
  loc.evaluate((e) => {
    const c = e.cloneNode(true);
    for (const n of c.querySelectorAll("[contenteditable=false]")) n.remove();
    return c.textContent;
  });
const memory = setInterval(async () => {
  const cgroup = await readFile("/sys/fs/cgroup/memory.current", "utf8").catch(() => null);
  await appendFile(
    root + "/memory.jsonl",
    JSON.stringify({
      at: Date.now(),
      nodeRss: process.memoryUsage().rss,
      cgroupBytes: cgroup ? Number(cgroup) : null,
    }) + "\n",
    { mode: 0o600 },
  );
}, 10000);
try {
  browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox"],
    env: { ...process.env, DISPLAY: capture.display },
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto("http://nextcloud/login");
  await page.getByRole("textbox", { name: "Account name or email", exact: true }).fill(i.username);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(i.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  const name = "Journey reliability soak " + Date.now() + ".txt";
  result.name = name;
  const seed = await fetch(
    "http://nextcloud/remote.php/dav/files/" + i.username + "/" + encodeURIComponent(name),
    {
      method: "PUT",
      headers: {
        authorization: "Basic " + Buffer.from(i.username + ":" + i.password).toString("base64"),
      },
      body: "Fictional reliability soak document\n",
    },
  );
  if (seed.status !== 201) throw Error("Unique seed failed");
  await page.goto("http://nextcloud/apps/files/files");
  await page.getByText(name, { exact: true }).filter({ visible: true }).first().click();
  const target = "[contenteditable=true]:has(pre > code)";
  await page.locator(target + " code").waitFor();
  const peer = await context.newPage();
  await peer.goto("http://nextcloud/apps/files/files");
  await peer.getByText(name, { exact: true }).filter({ visible: true }).first().click();
  await peer.locator(target).waitFor();
  await peer.locator(target).click();
  runtime = await sharedRuntime(context, clipboard);
  const started = Date.now();
  result.started = started;
  while (Date.now() - started < durationMs) {
    const n = result.iterations.length,
      expected = `Long journey checkpoint ${n + 1}\n\nCafé 日本語 😀\nReviewed ${n + 1} real browser edits.`;
    const action = await runtime.replace({
      page,
      target,
      text: expected,
      strategy: "native-control-scope",
    });
    if (action.status !== "accepted") throw Error("Input outcome " + action.status);
    await peer.waitForFunction(
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
    if ((await text(page.locator(target))) !== expected) throw Error("Independent text mismatch");
    result.iterations.push({
      number: n + 1,
      at: Date.now(),
      elapsedMs: Date.now() - started,
      verified: true,
      actionMs: action.elapsedMs,
    });
    await writeFile(root + "/progress.json", JSON.stringify(result, null, 2), { mode: 0o600 });
    if (n % 5 === 0) {
      await page.getByRole("button", { name: "Save document", exact: true }).click();
      await page.screenshot({ path: root + "/checkpoint-" + (n + 1) + ".png" });
    }
    if (capture.status.coverage !== "recording")
      throw Error("Recording stopped: " + capture.status.reason);
    console.log(
      JSON.stringify({
        root,
        checkpoint: n + 1,
        elapsedMs: Date.now() - started,
        recording: capture.status.coverage,
      }),
    );
    await sleep(Math.min(30000, Math.max(0, durationMs - (Date.now() - started))));
  }
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await sleep(1000);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByText(name, { exact: true }).filter({ visible: true }).first().click();
  await page.locator(target + " code").waitFor();
  await sleep(1000);
  result.finalReadback = await text(page.locator(target));
  result.passed =
    result.finalReadback ===
    `Long journey checkpoint ${result.iterations.length}\n\nCafé 日本語 😀\nReviewed ${result.iterations.length} real browser edits.`;
} catch (e) {
  result.error = e.message;
  result.passed = false;
} finally {
  clearInterval(memory);
  await runtime?.close();
  await context?.close();
  await browser?.close();
  result.recording = await capture.close(result.passed ? "complete" : "experiment_failed");
  result.ended = Date.now();
  result.passed =
    result.passed &&
    result.recording.coverage === "complete" &&
    Number(result.recording.duration) > 960;
  await writeFile(root + "/results.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      root,
      passed: result.passed,
      error: result.error,
      iterations: result.iterations.length,
      recording: result.recording,
    }),
  );
}
