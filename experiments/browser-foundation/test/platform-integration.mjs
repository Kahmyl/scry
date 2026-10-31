import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === "serve-app") {
  let writes = 0;
  createServer(async (req, res) => {
    const u = new URL(req.url, "http://target:8081");
    if (u.pathname === "/facts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ writes }));
      return;
    }
    if (req.method === "POST") {
      for await (const chunk of req) void chunk;
      writes++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ saved: true, writes }));
      return;
    }
    if (u.pathname === "/logout") {
      res.end("<!doctype html><h1>Signed out successfully</h1>");
      return;
    }
    if (u.pathname === "/popup") {
      res.end(
        "<!doctype html><h1>Child workspace</h1><button onclick='window.close()'>Close workspace</button>",
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Platform integration workspace</title><style>body{margin:0;font:18px system-ui;background:#eef2f8;color:#172c48}header{padding:22px;background:#183b65;color:white}main{padding:32px}input,button,select{font:inherit;margin:8px;padding:12px}svg{vertical-align:middle}#editor{border:2px solid #678;padding:20px;background:white}</style>
      <header><svg width="28" height="28"><circle cx="14" cy="14" r="12" fill="#56e0b2"/></svg> Professional workspace</header>
      <main><h1>Original styled application</h1><label>Email<input aria-label="Email" value="ordinary@example.invalid"></label><label>Password<input type="password" aria-label="Password"></label>
      <label>Public note<input aria-label="Public note"></label><button id="save">Save note</button><p role="status" id="status">Not saved</p>
      <div contenteditable="true" role="textbox" aria-label="Document editor" id="editor">Editable project document</div>
      <button onclick="alert('Confirm workspace')">Open dialog</button><a href="/popup" target="_blank">Open child workspace</a><a href="/logout">Sign out</a>
      <button id="slow" onclick="fetch('/save',{method:'POST',body:'once'});const end=Date.now()+12000;while(Date.now()<end){}">Save then busy</button>
      <script>document.querySelector('#save').onclick=async()=>{await fetch('/search',{method:'POST',body:'read'});await fetch('/save',{method:'POST',body:document.querySelector('[aria-label="Public note"]').value});document.querySelector('#status').textContent='Saved successfully'};</script></main>`);
  }).listen(8081, "0.0.0.0");
} else {
  const ledger = [];
  const check = (name, detail = {}) => {
    ledger.push({ name, ...detail });
    console.log(JSON.stringify({ check: name, ...detail }));
  };
  const { token, otherToken, credential } = await (
    await fetch("http://fixture:8080/fixture-input")
  ).json();
  const api = async (path, body, access = token) => {
    const r = await fetch("http://api:4000/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    });
    const value = await r.json();
    assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(value)}`);
    return value;
  };
  for (let n = 0; n < 60; n++) {
    if ((await fetch("http://api:4000/api/health").catch(() => ({ ok: false }))).ok) break;
    await sleep(1000);
  }
  assert.equal((await fetch("http://api:4000/api/projects")).status, 401);
  check("unauthenticated API rejected");
  const project = await api("/projects", {
    name: "Controlled browser integration " + randomUUID().slice(0, 8),
  });
  let session,
    seq = 0;
  const rpc = async (method, params) => {
    const r = await fetch("http://mcp:4100/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
      signal: AbortSignal.timeout(45000),
    });
    assert.ok(r.ok, `MCP ${method} ${r.status}`);
    session ??= r.headers.get("mcp-session-id");
    const envelope = await r.json();
    assert.ok(!envelope.error, JSON.stringify(envelope.error));
    return envelope.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "controlled-platform-qualification", version: "baseline" },
  });
  const tools = await rpc("tools/list", {});
  assert.ok(tools.tools.some((t) => t.name === "browser_navigate"));
  assert.ok(!tools.tools.some((t) => t.name === "command"));
  check("native public tool discovery", { tools: tools.tools.length });
  const call = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.ok(!result.isError, `tool ${name}: ${JSON.stringify(result)}`);
    assert.ok(
      !JSON.stringify(result).includes(credential),
      "bound credential escaped tool response",
    );
    return result;
  };
  const life = async (name, args) => (await call(name, args)).structuredContent;
  const env = await life("create_environment", {
    projectId: project.id,
    name: "Controlled fixture",
    baseOrigin: "http://target:8081",
    disclosureMode: "confidential",
  });
  const mission = await life("start_mission", {
    projectId: project.id,
    title: "Complete platform path",
    instruction:
      "Test the styled application, normal form save, secret input, dialog, child workspace and logout. Preserve evidence.",
    provider: "human",
  });
  const objective = await life("create_objective", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    title: "Real browser execution and evidence",
    completionCriteria: { journey: "saved and inspected" },
    objectiveOrder: 0,
  });
  const flow = await life("create_flow", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    name: "Complete integration journey",
  });
  const run = await life("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: env.environmentId,
  });
  let finalized = false;
  try {
    const browser = async (name, args = {}, actionId = randomUUID()) => {
      const result = await call(name, {
        ...args,
        browserSessionId: run.browserSessionId,
        actionId,
      });
      let command = result.structuredContent?.command;
      if (!command) {
        const pending = JSON.parse(result.content.find((c) => c.type === "text").text);
        for (let n = 0; n < 100; n++) {
          command = (await life("get_command", { commandId: pending.commandId })).command;
          if (["failed", "completed"].includes(command.state)) break;
          await sleep(250);
        }
      }
      assert.equal(command.state, "completed", `browser ${name}: ${JSON.stringify(command)}`);
      assert.equal(command.result?.execution, "completed", `browser tool did not succeed: ${name}`);
      return { ...result, command };
    };
    await browser("browser_navigate", { url: "http://target:8081/" });
    const before = await browser("browser_take_screenshot", { type: "png" });
    assert.ok(before.content.some((c) => c.type === "image"));
    check("open admitted screenshot returned as MCP image");
    await browser("browser_take_screenshot", { type: "png" });
    assert.equal((await api(`/runs/${run.runId}/media`)).items.length, 1);
    check("unchanged screenshot deduplicated");
    for (const [name, args] of [
      ["browser_navigate", { url: "http://outside.invalid/" }],
      ["browser_click", { target: "#not-present" }],
    ]) {
      const rejected = await rpc("tools/call", {
        name,
        arguments: { ...args, browserSessionId: run.browserSessionId, actionId: randomUUID() },
      });
      assert.equal(rejected.isError, true, `Refusal was presented as success: ${name}`);
    }
    assert.ok(
      JSON.stringify(await browser("browser_snapshot")).includes("Original styled application"),
    );
    check("scope refusal and ordinary selector error preserve context with honest MCP errors");
    // Late credential binding is an ordinary workflow, not a browser restart.
    const saved = await life("create_credential", {
      projectId: project.id,
      displayName: "Explicit fictional integration secret",
      value: credential,
      idempotencyKey: randomUUID(),
    });
    await life("bind_credentials", {
      runId: run.runId,
      protectedInputIds: [saved.protectedValueId],
      userConfirmed: true,
    });
    await browser("browser_type_secret", {
      target: "input[aria-label='Password']",
      protectedValueId: saved.protectedValueId,
    });
    await browser("browser_type", {
      target: "input[aria-label='Public note']",
      text: "Ordinary business content remains visible",
    });
    const id = randomUUID();
    const writesBefore = (await (await fetch("http://target:8081/facts")).json()).writes;
    const savedAction = await browser("browser_click", { target: "#save" }, id);
    await browser("browser_click", { target: "#save" }, id);
    assert.equal((await (await fetch("http://target:8081/facts")).json()).writes, writesBefore + 2);
    check("POST read plus business write; durable idempotent action not repeated");
    const snap = await browser("browser_snapshot");
    assert.ok(JSON.stringify(snap).includes("Saved successfully"));
    const media = await browser("browser_take_screenshot", { type: "png" });
    assert.ok(media.content.some((c) => c.type === "image"));
    const listing = await api(`/runs/${run.runId}/media`);
    assert.ok(listing.items.length >= 2);
    check("active authorized screenshot publication", { screenshots: listing.items.length });
    const denied = await fetch(`http://api:4000/api/runs/${run.runId}/media`, {
      headers: { authorization: "Bearer " + otherToken },
    });
    assert.ok([403, 404].includes(denied.status));
    assert.equal((await fetch(`http://api:4000/api/runs/${run.runId}/media/0`)).status, 401);
    assert.ok(
      [403, 404].includes(
        (
          await fetch(`http://api:4000/api/runs/${run.runId}/media/0`, {
            headers: { authorization: "Bearer " + otherToken },
          })
        ).status,
      ),
    );
    check("other-workspace evidence rejected");
    const req = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
    const { default: pg } = await import(req.resolve("pg"));
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const stored = await db.query(
      "SELECT safe_input,protected_input_ciphertext FROM browser_commands WHERE id=$1",
      [savedAction.command.id],
    );
    assert.ok(stored.rows[0].protected_input_ciphertext);
    assert.ok(!JSON.stringify(stored.rows[0].safe_input).includes("#save"));
    await assert.rejects(() =>
      db.query("UPDATE browser_execution_sessions SET runtime_adapter='legacy' WHERE id=$1", [
        run.browserSessionId,
      ]),
    );
    check("encrypted command arguments and immutable adapter");
    await browser("browser_click", { target: "text=Open dialog" });
    await browser("browser_handle_dialog", { accept: true });
    check("native dialog handling");
    await browser("browser_click", { target: "text=Open child workspace" });
    const tabs = await browser("browser_tabs", { action: "list" });
    assert.ok(JSON.stringify(tabs).includes("http://target:8081/popup"));
    await browser("browser_tabs", { action: "select", index: 1 });
    assert.ok(JSON.stringify(await browser("browser_snapshot")).includes("Child workspace"));
    await browser("browser_tabs", { action: "select", index: 0 });
    check("popup and tab routing");
    await browser("browser_click", { target: "text=Sign out" });
    const logout = await browser("browser_snapshot");
    assert.ok(JSON.stringify(logout).includes("Signed out successfully"));
    check("GET-based logout");
    const owned = await api(`/runs/${run.runId}`);
    await life("finalize_run", {
      runId: run.runId,
      ownerGeneration: Number(owned.ownerGeneration),
      outcome: "passed",
      conclusion: "Public MCP journey and native evidence verified",
    });
    finalized = true;
    const report = await life("publish_mission_report", {
      missionId: mission.missionId,
      agentSessionId: mission.agentSessionId,
      summary: "Controlled integration complete",
      safeReport: { tested: "original UI, form save, secret fill, dialog, tabs, GET logout" },
    });
    const published = await api(`/runs/${run.runId}/media`),
      video = published.items.find((m) => m.kind === "video");
    assert.ok(video);
    assert.equal(video.coverage, "complete");
    const r = await fetch(`http://api:4000/api/runs/${run.runId}/media/${video.index}`, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(r.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), video.artifactId);
    await mkdir("/integration-evidence/qualification", { recursive: true });
    await writeFile("/integration-evidence/qualification/recording.mp4", bytes);
    await writeFile(
      "/integration-evidence/qualification/result.json",
      JSON.stringify(
        {
          runId: run.runId,
          missionId: mission.missionId,
          reportId: report.reportId,
          checks: ledger,
          video,
          finished: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    await db.end();
    check("sealed Chronicle video, API bytes and Mission report", {
      runId: run.runId,
      missionId: mission.missionId,
      bytes: bytes.length,
    });
  } finally {
    if (!finalized) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const owned = await api(`/runs/${run.runId}`);
        try {
          await api(`/runs/${run.runId}/finalize`, {
            ownerGeneration: Number(owned.ownerGeneration) || 1,
            outcome: "environment_failure",
            conclusion: "Qualification stopped at an assertion; retain its actual evidence.",
          });
          break;
        } catch (error) {
          if (!String(error.message).includes("OWNER_FENCED")) break;
        }
      }
    }
  }
}
