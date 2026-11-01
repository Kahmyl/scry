import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = "/results/recovery-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const configFile = root + "/config.json";
await writeFile(
  configFile,
  JSON.stringify({
    root: root + "/store",
    workspace: "recovery-lab",
    deadlineMs: 12000,
    environments: {
      normal: { allowTesting: true, origins: ["http://diagnosis:8080"] },
      quota: { allowTesting: true, origins: ["http://diagnosis:8080"], recording: { maxMs: 1800 } },
    },
  }),
  { mode: 0o600 },
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let client, transport;
const results = [];
let seq = 0;
const json = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);
const text = (r) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
async function connect() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    env: { ...process.env, SCRY_CANDIDATE_CONFIG: configFile },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "public-recovery-trial", version: "experiment" });
  await client.connect(transport);
}
const call = (name, args) => client.callTool({ name, arguments: args });
const browser = (runId, name, args = {}, actionId = "action-" + ++seq) =>
  call(name, { runId, actionId, ...args });
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
  await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
await connect();
try {
  await test("parent death retains prior success and makes in-flight action unknown", async () => {
    const { runId } = json(await call("scry_start_test", { environment: "normal" }));
    const nav = await browser(
      runId,
      "browser_navigate",
      { url: "http://diagnosis:8080/case/hang" },
      "navigation",
    );
    assert.equal(nav.isError, false);
    const snapshot = text(await browser(runId, "browser_snapshot"));
    const target = snapshot.match(/button "Unresponsive application".*\[ref=([^\]]+)\]/)[1];
    const inflight = browser(runId, "browser_click", { target }, "inflight").catch(() => null);
    await delay(700);
    const before = json(await call("scry_test_status", { runId }));
    assert.equal(before.actions.find((a) => a.actionId === "inflight").execution, "running");
    process.kill(transport.pid, "SIGKILL");
    await inflight;
    await client.close().catch(() => {});
    await delay(1800);
    await connect();
    const after = json(await call("scry_test_status", { runId }));
    assert.equal(after.state, "interrupted");
    assert.equal(after.actions.find((a) => a.actionId === "navigation").execution, "succeeded");
    assert.equal(after.actions.find((a) => a.actionId === "inflight").execution, "unknown");
    assert.equal(after.actions.find((a) => a.actionId === "inflight").businessOutcome, "unknown");
    assert.equal(after.evidence.coverage, "partial");
    assert.ok(!after.evidence.unavailable);
    const retry = json(await browser(runId, "browser_click", { target }, "inflight"));
    assert.equal(retry.replay, true);
    assert.equal(retry.receipt.execution, "unknown");
  });
  await test("cancellation interrupts only its browser and retains a playable prefix", async () => {
    const { runId } = json(await call("scry_start_test", { environment: "normal" }));
    await browser(runId, "browser_navigate", { url: "http://diagnosis:8080/case/hang" });
    const s = text(await browser(runId, "browser_snapshot"));
    const target = s.match(/button "Unresponsive application".*\[ref=([^\]]+)\]/)[1];
    const next = json(await call("scry_start_test", { environment: "normal" }));
    await browser(next.runId, "browser_navigate", { url: "http://diagnosis:8080/case/timeout" });
    const pending = browser(runId, "browser_click", { target }).catch(() => null);
    await delay(500);
    const cancelled = json(await call("scry_cancel_test", { runId }));
    await pending;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.evidence.coverage, "partial");
    assert.ok(!cancelled.evidence.unavailable);
    assert.equal(
      (await browser(next.runId, "browser_navigate", { url: "http://diagnosis:8080/result" }))
        .isError,
      false,
    );
    await call("scry_finish_test", { runId: next.runId, outcome: "completed" });
  });
  await test("recording quota does not disable browser interaction", async () => {
    const { runId } = json(await call("scry_start_test", { environment: "quota" }));
    await browser(runId, "browser_navigate", { url: "http://diagnosis:8080/case/timeout" });
    await delay(2300);
    const s = text(await browser(runId, "browser_snapshot"));
    const target = s.match(/textbox "Visible note".*\[ref=([^\]]+)\]/)[1];
    const r = await browser(runId, "browser_type", {
      target,
      text: "Browser remains usable after video quota",
    });
    assert.equal(r.isError, false);
    const final = json(await call("scry_finish_test", { runId, outcome: "completed" }));
    assert.equal(final.evidence.coverage, "partial");
    assert.equal(final.evidence.reason, "recording_duration");
  });
  await test("native renderer loss is reported, does not hang masking, and leaves recovery usable", async () => {
    const { runId } = json(await call("scry_start_test", { environment: "normal" }));
    await browser(runId, "browser_navigate", { url: "http://diagnosis:8080/case/timeout" });
    const processes = execFileSync("ps", ["-eo", "pid,ppid,rss,args"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: +m[1], parent: +m[2], rss: +m[3], args: m[4] }));
    const owned = new Set([transport.pid]);
    for (let i = 0; i < 8; i++)
      for (const p of processes) if (owned.has(p.parent)) owned.add(p.pid);
    const renderer = processes
      .filter(
        (p) =>
          owned.has(p.pid) &&
          p.args.includes("--type=renderer") &&
          !p.args.includes("--top-chrome-webui"),
      )
      .sort((a, b) => b.rss - a.rss)[0];
    assert.ok(renderer, "No renderer owned by this test server");
    process.kill(renderer.pid, "SIGKILL");
    await delay(700);
    const status = json(await call("scry_test_status", { runId }));
    assert.ok(status.findings.some((f) => f.summary.includes("browser tab crashed")));
    const tabs = await browser(runId, "browser_tabs", { action: "list" });
    assert.match(text(tabs), /crashed|browser tab crashed/i);
    const next = await browser(runId, "browser_navigate", {
      url: "http://diagnosis:8080/case/timeout",
    });
    assert.equal(next.isError, false);
    assert.match(text(next), /browser tab crashed/i);
    const s = text(await browser(runId, "browser_snapshot"));
    const target = s.match(/textbox "Visible note".*\[ref=([^\]]+)\]/)[1];
    assert.equal(
      (await browser(runId, "browser_type", { target, text: "Recovered after renderer loss" }))
        .isError,
      false,
    );
    const final = json(await call("scry_finish_test", { runId, outcome: "failed" }));
    assert.ok(!final.evidence.unavailable);
  });
  await test("private worker and recorder processes are cleaned up", async () => {
    await client.close();
    await delay(1000);
    const processes = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .filter((s) => !s.includes("<defunct>"));
    assert.equal(
      processes.some((s) => s.includes("src/browser-worker.mjs")),
      false,
    );
    assert.equal(
      processes.some((s) => s.startsWith("Xvfb -displayfd")),
      false,
    );
    assert.equal(
      processes.some((s) => s.startsWith("ffmpeg -hide_banner")),
      false,
    );
  });
} finally {
  await client.close().catch(() => {});
  await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({ root, passed: results.filter((r) => r.ok).length, total: results.length }),
  );
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
