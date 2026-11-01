import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
const root = "/results/trial-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const config = {
  root: root + "/store",
  workspace: "foundation-lab",
  deadlineMs: 10000,
  environments: {
    diagnostic: {
      allowTesting: true,
      origins: ["http://diagnosis:8080", "http://diagnosis-assets:8080"],
    },
    strict: { allowTesting: true, origins: ["http://diagnosis:8080"] },
  },
  secrets: { diagnostic: { password: "Fictional-private-password-123" } },
};
const configFile = root + "/config.json";
await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  env: { ...process.env, SCRY_CANDIDATE_CONFIG: configFile },
  stderr: "pipe",
});
let diagnostics = "";
transport.stderr?.on("data", (b) => {
  diagnostics = (diagnostics + b).slice(-5000);
});
const client = new Client({ name: "public-mcp-foundation-qualification", version: "experiment" });
await client.connect(transport).catch(async (error) => {
  await writeFile(root + "/startup-error.txt", diagnostics, { mode: 0o600 });
  throw error;
});
const results = [],
  calls = [];
let seq = 0;
const text = (r) =>
  r.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
const json = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  calls.push({
    tool: name,
    args,
    result: r.content.filter((c) => c.type === "text"),
    isError: r.isError ?? false,
  });
  return r;
}
const browser = async (runId, name, args = {}, actionId = "action-" + ++seq) =>
  call(name, { runId, actionId, ...args });
const snap = async (runId) => text(await browser(runId, "browser_snapshot"));
function ref(snapshot, label) {
  const line = snapshot
    .split("\n")
    .find((l) => l.includes('"' + label + '"') && l.includes("[ref="));
  assert.ok(line, "Missing usable control: " + label);
  return line.match(/\[ref=([^\]]+)\]/)[1];
}
const facts = (tag) =>
  fetch("http://diagnosis:8080/facts")
    .then((r) => r.json())
    .then((f) => f[tag]);
async function journey(name, fn, environment = "diagnostic") {
  if (process.argv.slice(2).length && !process.argv.slice(2).includes(name)) return;
  const row = { name, started: Date.now() };
  results.push(row);
  let runId;
  try {
    const started = json(await call("scry_start_test", { environment }));
    runId = started.runId;
    assert.ok(runId, "start failed " + JSON.stringify(started));
    row.runId = runId;
    const tag = "foundation-" + name + "-" + randomUUID();
    row.tag = tag;
    const nav = await browser(runId, "browser_navigate", {
      url: "http://diagnosis:8080/case/" + name + "?tag=" + tag,
    });
    assert.equal(nav.isError, false, "navigation: " + text(nav));
    await fn({ runId, tag, snapshot: await snap(runId), row });
    const finished = json(await call("scry_finish_test", { runId, outcome: "completed" }));
    row.final = finished;
    assert.ok(finished.evidence && !finished.evidence.unavailable, "native evidence missing");
    row.ok = true;
  } catch (e) {
    row.ok = false;
    row.error = String(e.message);
    if (runId) row.final = json(await call("scry_finish_test", { runId, outcome: "failed" }));
  } finally {
    row.ended = Date.now();
    await writeFile(root + "/results.json", JSON.stringify({ root, results, calls }, null, 2));
    console.log(
      JSON.stringify({
        name: row.name,
        ok: row.ok,
        error: row.error,
        runId: row.runId,
        coverage: row.final?.evidence?.coverage,
      }),
    );
  }
}
try {
  const tools = (await client.listTools()).tools;
  const environments = json(await call("scry_list_environments", {}));
  assert.deepEqual(
    environments.environments.map((e) => e.environment),
    ["diagnostic", "strict"],
  );
  assert.equal(
    tools.some((t) => t.name === "browser_evaluate"),
    false,
  );
  assert.equal(
    tools.some((t) => t.name === "browser_run_code"),
    false,
  );
  assert.equal(
    tools.some((t) => t.name === "browser_snapshot"),
    true,
  );
  await journey("postread", async ({ runId, tag, snapshot }) => {
    const r = await browser(runId, "browser_click", { target: ref(snapshot, "Open customers") });
    assert.equal(r.isError, false);
    assert.match(await snap(runId), /Customer Alpha/);
    assert.equal((await facts(tag)).read, 1);
  });
  await journey("multi", async ({ runId, tag, snapshot }) => {
    const target = ref(snapshot, "Save order");
    const r = await browser(runId, "browser_click", { target }, "save-once");
    assert.equal(r.isError, false);
    assert.match(await snap(runId), /Order saved/);
    assert.equal((await facts(tag)).save, 1);
    assert.equal((await facts(tag)).telemetry, 1);
    const retry = await browser(runId, "browser_click", { target }, "save-once");
    assert.equal(json(retry).replay, true);
    assert.equal((await facts(tag)).save, 1);
    assert.equal(
      (await browser(runId, "browser_click", { target: "other" }, "save-once")).isError,
      true,
    );
  });
  for (const name of ["getlogout", "readonlyget"])
    await journey(name, async ({ runId, tag, snapshot }) => {
      const r = await browser(runId, "browser_click", { target: ref(snapshot, "Sign out") });
      assert.equal(r.isError, false);
      assert.equal(json(r).receipt.execution, "succeeded");
      assert.match(await snap(runId), /Signed out/);
      assert.equal((await facts(tag)).logout, 1);
    });
  await journey("assets", async ({ runId, tag, snapshot }) => {
    await browser(runId, "browser_click", { target: ref(snapshot, "Save product") });
    assert.match(await snap(runId), /Saved and icon loaded/);
    assert.equal((await facts(tag)).image, 1);
  });
  await journey("redirectsame", async ({ runId, tag, snapshot }) => {
    await browser(runId, "browser_click", { target: ref(snapshot, "Save and continue") });
    assert.match(await snap(runId), /Redirect result/);
    assert.equal((await facts(tag)).save, 1);
  });
  await journey(
    "redirect",
    async ({ runId, tag, snapshot }) => {
      const r = await browser(runId, "browser_click", {
        target: ref(snapshot, "Save and continue"),
      });
      assert.equal((await facts(tag)).save, 1);
      assert.notEqual(json(r).receipt.execution, "not_dispatched");
      assert.equal(json(r).receipt.businessOutcome, "not_inferred");
      const status = json(await call("scry_test_status", { runId }));
      assert.ok(
        status.actions.some((a) =>
          a.policyBlocks?.some((b) => b.origin === "http://diagnosis-assets:8080"),
        ),
      );
    },
    "strict",
  );
  await journey("controls", async ({ runId, snapshot }) => {
    assert.match(snapshot, /textbox "Work email"/);
    assert.match(snapshot, /textbox "Rich editor"/);
    assert.match(snapshot, /Embedded frame action/);
    assert.match(snapshot, /Important final action/);
    assert.doesNotMatch(snapshot, /Hidden duplicate/);
    const concurrent = await Promise.all([
      browser(runId, "browser_type", {
        target: ref(snapshot, "Work email"),
        text: "fictional@example.invalid",
      }),
      browser(runId, "browser_type", {
        target: ref(snapshot, "Rich editor"),
        text: "Rich content works",
      }),
    ]);
    assert.ok(concurrent.every((result) => !result.isError));
    assert.ok(json(concurrent[1]).receipt.started >= json(concurrent[0]).receipt.finished);
    assert.match(await snap(runId), /fictional@example.invalid/);
    assert.match(await snap(runId), /Rich content works/);
    await browser(runId, "browser_click", {
      target: ref(await snap(runId), "Embedded frame action"),
    });
    assert.match(await snap(runId), /Frame clicked/);
  });
  await journey("timeout", async ({ runId, snapshot }) => {
    assert.doesNotMatch(snapshot, /button "Hidden action"/);
    const r = await browser(runId, "browser_click", { target: "button" });
    assert.equal(r.isError, true);
    assert.match(text(r), /Timeout|visible|timeout/i);
    const s = await snap(runId);
    await browser(runId, "browser_type", {
      target: ref(s, "Visible note"),
      text: "Context still usable",
    });
    assert.match(await snap(runId), /Context still usable/);
    const waited = await browser(runId, "browser_wait_for", { text: "Normal usable page" });
    assert.equal(waited.isError, false);
    const absent = await browser(runId, "browser_wait_for", {
      text: "Never-present qualification text",
    });
    assert.equal(absent.isError, true);
    assert.equal(json(absent).receipt.error.category, "actionability_timeout");
    assert.equal(json(absent).receipt.businessOutcome, "not_inferred");
    const oversizedWait = await browser(runId, "browser_wait_for", { time: 11 });
    assert.equal(text(oversizedWait), "INVALID_TOOL_ARGUMENTS");
    assert.equal((await browser(runId, "browser_snapshot")).isError, false);
  });
  await journey("autofill", async ({ runId, tag, snapshot }) => {
    await browser(runId, "browser_type", {
      target: ref(snapshot, "Customer name"),
      text: "Fictional customer",
    });
    assert.equal((await facts(tag)).save, 1);
    assert.match(await snap(runId), /Autosave persisted/);
    const status = json(await call("scry_test_status", { runId }));
    assert.ok(status.actions.some((a) => a.tool === "browser_type" && a.execution === "succeeded"));
  });
  await journey("delayed", async ({ runId, tag, snapshot }) => {
    await browser(runId, "browser_click", { target: ref(snapshot, "Schedule autosave") });
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await facts(tag)).save, 1);
    assert.match(await snap(runId), /Deferred save persisted/);
  });
  await journey("secrets", async ({ runId, snapshot }) => {
    assert.equal(
      (
        await browser(runId, "browser_type", {
          target: ref(snapshot, "Email"),
          text: "visible@example.invalid",
        })
      ).isError,
      false,
    );
    assert.equal(
      (
        await browser(runId, "browser_type_secret", {
          target: ref(await snap(runId), "Password"),
          secretId: "password",
        })
      ).isError,
      false,
    );
    const s = await snap(runId);
    assert.doesNotMatch(s, /Fictional-private-password-123/);
    assert.match(s, /visible@example.invalid/);
    assert.match(s, /Ordinary customer and business content/);
    await new Promise((r) => setTimeout(r, 1200));
    const image = await browser(runId, "browser_take_screenshot", { type: "png", scale: "css" });
    assert.equal(image.isError, false, text(image));
    assert.ok(
      image.content.some((c) => c.type === "image"),
      "Screenshot must be accessible without private filesystem knowledge",
    );
    for (const c of image.content ?? [])
      if (c.type === "image")
        await writeFile(root + "/secret-mask.png", Buffer.from(c.data, "base64"));
  });
  await journey("widgets", async ({ runId, snapshot }) => {
    assert.equal(
      (
        await browser(runId, "browser_select_option", {
          target: ref(snapshot, "Country"),
          values: ["Japan"],
        })
      ).isError,
      false,
    );
    assert.match(await snap(runId), /Japan.*selected/);
    await browser(runId, "browser_click", { target: ref(await snap(runId), "Agree") });
    assert.match(await snap(runId), /Agree.*checked/);
    await browser(runId, "browser_click", { target: ref(await snap(runId), "Confirm action") });
    assert.equal((await browser(runId, "browser_handle_dialog", { accept: true })).isError, false);
    assert.match(await snap(runId), /Confirmed/);
    await browser(runId, "browser_tabs", { action: "new", url: "http://diagnosis:8080/result" });
    assert.match(await snap(runId), /Redirect result/);
    await browser(runId, "browser_tabs", { action: "select", index: 0 });
    assert.match(await snap(runId), /Normal interaction controls/);
    assert.equal(
      (await browser(runId, "browser_tabs", { action: "close", index: 1 })).isError,
      false,
    );
  });
  await journey("surface", async ({ runId, snapshot }) => {
    const invoke = async (tool, args) => {
      const r = await browser(runId, tool, args);
      assert.equal(r.isError, false, tool + ": " + text(r));
      return r;
    };
    await invoke("browser_fill_form", {
      fields: [
        { target: ref(snapshot, "Name"), name: "Name", type: "textbox", value: "Batch form works" },
        { target: ref(snapshot, "Accept"), name: "Accept", type: "checkbox", value: "true" },
        { target: ref(snapshot, "Mode"), name: "Mode", type: "combobox", value: "Beta" },
      ],
    });
    let s = await snap(runId);
    assert.match(s, /Batch form works/);
    assert.match(s, /Accept.*checked/);
    assert.match(s, /Beta.*selected/);
    await invoke("browser_hover", { target: ref(s, "Hover target") });
    assert.match(await snap(runId), /Hover count 1/);
    await invoke("browser_mouse_move_xy", { x: 500, y: 500 });
    await invoke("browser_mouse_move_xy", { x: 60, y: 160 });
    assert.match(await snap(runId), /Hover count 2/);
    await invoke("browser_mouse_click_xy", { x: 60, y: 220 });
    assert.match(await snap(runId), /Coordinate clicked/);
    s = await snap(runId);
    await invoke("browser_drag", {
      startTarget: ref(s, "Drag source"),
      endTarget: ref(s, "Drop area"),
    });
    assert.match(await snap(runId), /DOM drop accepted/);
    await invoke("browser_mouse_move_xy", { x: 40, y: 360 });
    await invoke("browser_mouse_down", {});
    assert.match(await snap(runId), /Pointer down/);
    await invoke("browser_mouse_up", {});
    assert.match(await snap(runId), /Pointer up/);
    await invoke("browser_mouse_drag_xy", { startX: 40, startY: 360, endX: 250, endY: 360 });
    assert.match(await snap(runId), /Pointer moved while pressed/);
    await invoke("browser_mouse_move_xy", { x: 400, y: 80 });
    await invoke("browser_mouse_wheel", { deltaX: 0, deltaY: 500 });
    await invoke("browser_wait_for", { text: "Wheel scrolled" });
    await invoke("browser_navigate", { url: "http://diagnosis:8080/result" });
    await invoke("browser_navigate_back", {});
    assert.match(await snap(runId), /Tool surface/);
  });
  await journey("hang", async ({ runId, snapshot }) => {
    const r = await browser(runId, "browser_click", {
      target: ref(snapshot, "Unresponsive application"),
    });
    const receipt = json(r).receipt;
    assert.ok(["failed", "unknown"].includes(receipt.execution));
    assert.equal(receipt.businessOutcome, "unknown");
    const status = json(await call("scry_test_status", { runId }));
    assert.equal(status.state, "BROWSER_HARD_DEADLINE");
    assert.equal(status.evidence.coverage, "partial");
    assert.ok(!status.evidence.unavailable);
  });
} finally {
  await writeFile(root + "/results.json", JSON.stringify({ root, results, calls }, null, 2));
  await client.close();
  console.log(
    JSON.stringify({
      summary: { root, passed: results.filter((r) => r.ok).length, total: results.length },
    }),
  );
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
