import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

// API-owned production-shaped fixture: database fault setup stays outside
// Assurance analysis. This file is mounted only into the disposable test stack.
// This issuer exists only inside the fresh, portless qualification network.
// The real API still verifies issuer, audience, signature and scoped identity.
if (process.argv[2] === "serve") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "ES256", use: "sig" };
  const users = [randomUUID(), randomUUID()];
  const credential = `fixture-only-secret-${randomUUID()}`;
  const token = (index) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "ES256", kid: key.kid, typ: "JWT" })}.${encode({ sub: users[index], email: `fixture-${index}@example.invalid`, iss: "http://fixture:8080/auth/v1", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 })}`;
    return `${payload}.${sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const user = {
    id: users[0],
    email: "fixture-0@example.invalid",
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
  };
  createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture:8080");
    response.setHeader("content-type", "application/json");
    response.setHeader("access-control-allow-origin", "http://web:3000");
    response.setHeader(
      "access-control-allow-headers",
      "authorization,apikey,content-type,x-client-info,x-supabase-api-version",
    );
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }
    if (url.pathname === "/auth/v1/token" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) {
          response.writeHead(413);
          return response.end('{"message":"fixture_input_too_large"}');
        }
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        response.writeHead(400);
        return response.end('{"message":"fixture_input_invalid"}');
      }
      if (input.email !== user.email || input.password !== "fixture-ui-signin-only") {
        response.writeHead(400);
        return response.end('{"message":"fixture_credentials_invalid"}');
      }
      return response.end(
        JSON.stringify({
          access_token: token(0),
          token_type: "bearer",
          expires_in: 900,
          expires_at: Math.floor(Date.now() / 1000) + 900,
          refresh_token: "fictional-refresh-only",
          user,
        }),
      );
    }
    if (url.pathname === "/auth/v1/user") {
      try {
        const [header, claims, signature] = (request.headers.authorization ?? "")
          .replace(/^Bearer /, "")
          .split(".");
        const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
        if (
          payload.sub !== users[0] ||
          payload.exp <= Date.now() / 1000 ||
          !verify(
            "sha256",
            Buffer.from(`${header}.${claims}`),
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            Buffer.from(signature, "base64url"),
          )
        )
          throw new Error("invalid");
        return response.end(JSON.stringify(user));
      } catch {
        response.writeHead(401);
        return response.end('{"message":"fixture_user_refused"}');
      }
    }
    if (url.pathname === "/auth/v1/.well-known/jwks.json")
      return response.end(JSON.stringify({ keys: [key] }));
    if (url.pathname === "/fixture-input")
      return response.end(JSON.stringify({ token: token(0), otherToken: token(1), credential }));
    if (url.pathname === "/app") {
      response.setHeader("content-type", "text/html");
      return response.end(
        '<!doctype html><title>Baseline fixture</title><main><h1>Ready for qualification</h1><input type="password" aria-label="Protected value"><a href="/app">Read only navigation</a></main>',
      );
    }
    if (url.pathname === "/availability-app") {
      response.setHeader("content-type", "text/html");
      return response.end(
        '<!doctype html><title>Availability fixture</title><main><h1>Original application remains healthy</h1><input aria-label="Fictional public note">' +
          Array.from(
            { length: 1200 },
            (_, index) => `<p>Fictional workspace row ${index}</p>`,
          ).join("") +
          "</main>",
      );
    }
    if (process.env.SCRY_FIXTURE_REVIEW === "true" && url.pathname !== "/health") {
      if (url.pathname === "/config.js") {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        return response.end(
          `window.__SCRY_CONFIG__=${JSON.stringify({ apiBaseUrl: "/api", supabaseUrl: `http://${request.headers.host}`, supabasePublishableKey: "isolated-fixture-only", mcpServerUrl: "/mcp" })};`,
        );
      }
      try {
        const isApi = url.pathname.startsWith("/api/");
        const target = `${isApi ? "http://api:4000" : "http://web:3000"}${url.pathname}${url.search}`;
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 131072) throw new Error("fixture_request_limit");
          chunks.push(chunk);
        }
        const headers = {};
        for (const key of ["authorization", "content-type"])
          if (request.headers[key]) headers[key] = request.headers[key];
        const upstream = await fetch(target, {
          method: request.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          signal: AbortSignal.timeout(30000),
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > 8 * 1024 * 1024) throw new Error("fixture_response_limit");
        response.statusCode = upstream.status;
        response.setHeader(
          "content-type",
          upstream.headers.get("content-type") ?? "application/octet-stream",
        );
        return response.end(body);
      } catch {
        response.writeHead(502);
        return response.end('{"message":"isolated_review_upstream_unavailable"}');
      }
    }
    response.end('{"ready":true}');
  }).listen(8080, "0.0.0.0");
} else {
  try {
    await exercise();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

async function exercise() {
  const { token, otherToken, credential } = await (
    await fetch("http://fixture:8080/fixture-input")
  ).json();
  const api = async (target, body, accessToken = token) => {
    const response = await fetch(`http://api:4000/api${target}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(40_000),
    });
    assert.ok(response.ok, `API fixture request refused: ${target} (${response.status})`);
    return response.json();
  };
  assert.equal((await fetch("http://api:4000/api/projects")).status, 401);
  const project = await api("/projects", {
    name: "Isolated deployed baseline",
    description: "Public interface qualification",
  });
  let sessionId;
  let sequence = 0;
  const rpc = async (method, params) => {
    const response = await fetch("http://mcp:4100/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.timeout(45_000),
    });
    assert.ok(response.ok, `MCP fixture request refused: ${method} (${response.status})`);
    sessionId ??= response.headers.get("mcp-session-id");
    const envelope = await response.json();
    assert.ok(!envelope.error, `MCP fixture protocol failure: ${method}`);
    return envelope.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "assurance-fixture", version: "baseline" },
  });
  assert.ok(sessionId, "MCP_SESSION_NOT_RETAINED");
  const tools = await rpc("tools/list", {});
  assert.equal(tools.tools.length, 16);
  const call = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.ok(!result.isError, `MCP fixture tool refused: ${name}`);
    assert.ok(result.structuredContent, `MCP fixture tool omitted facts: ${name}`);
    assert.ok(!JSON.stringify(result).includes(credential), "PROTECTED_VALUE_ESCAPED");
    return result.structuredContent;
  };
  const environment = await call("create_environment", {
    projectId: project.id,
    name: "Isolated fixture",
    baseOrigin: "http://fixture:8080",
    disclosureMode: "confidential",
  });
  const saved = await call("create_credential", {
    projectId: project.id,
    displayName: "Explicit fixture credential",
    value: credential,
    idempotencyKey: randomUUID(),
  });
  const mission = await call("start_mission", {
    projectId: project.id,
    title: "Deployed baseline",
    instruction:
      "Read the local fixture, fill the explicitly supplied credential, and close with evidence.",
    provider: "human",
  });
  const objective = await call("create_objective", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    title: "Protected browser read",
    completionCriteria: { fixture: "observed" },
    objectiveOrder: 0,
  });
  const flow = await call("create_flow", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    name: "Public fixture journey",
  });
  const run = await call("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: environment.environmentId,
    protectedInputIds: [saved.protectedValueId],
  });
  const command = async (input, execution = run) => {
    let result = await call("command", {
      browserSessionId: execution.browserSessionId,
      command: input,
    });
    for (
      let attempt = 0;
      !["completed", "failed"].includes(result.state) && attempt < 40;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const observed = await call("get_command", { commandId: result.commandId });
      result = { ...result, state: observed.command.state, command: observed.command };
    }
    assert.equal(result.state, "completed", `BROWSER_COMMAND_FAILED: ${input.kind}`);
    return result.command.result;
  };
  await command({ kind: "navigate", url: "http://fixture:8080/app" });
  const observed = await command({ kind: "observe" });
  const control = observed.controls.find((entry) => entry.type === "password");
  assert.ok(control?.reference, "PROTECTED_CONTROL_NOT_OBSERVED");
  await command({
    kind: "fill",
    reference: control.reference,
    protectedValueId: saved.protectedValueId,
  });
  await command({ kind: "observe" });
  const owned = await api(`/runs/${run.runId}`);
  assert.ok(Number(owned.ownerGeneration) > 0, "BROWSER_OWNER_NOT_CLAIMED");
  await command({ kind: "close" });
  await call("finalize_run", {
    runId: run.runId,
    ownerGeneration: Number(owned.ownerGeneration),
    outcome: "passed",
    conclusion: "Protected fixture read completed",
  });
  const report = await call("publish_mission_report", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    summary: "Deployed fixture complete",
    safeReport: { outcome: "passed", privacyProbe: credential },
  });
  const finished = await api(`/runs/${run.runId}`);
  assert.equal(finished.state, "passed");
  assert.ok(
    finished.evidence.some(
      (entry) => entry.state === "complete" && entry.chunkCount > 0 && entry.chainHead,
    ),
    "EVIDENCE_NOT_COMPLETE",
  );
  const published = await api(`/reports/${report.reportId}`);
  assert.ok(published.evidenceDigest, "REPORT_NOT_BOUND_TO_EVIDENCE");
  assert.ok(!JSON.stringify(published).includes(credential), "REPORT_DISCLOSED_PROTECTED_VALUE");
  const denied = await fetch(`http://api:4000/api/runs/${run.runId}`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.ok(!denied.ok, "CROSS_WORKSPACE_RUN_VISIBLE");
  const mismatched = await fetch("http://mcp:4100/mcp", {
    headers: {
      authorization: `Bearer ${otherToken}`,
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(mismatched.status, 401);
  const artifactFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else artifactFiles.push(target);
    }
  };
  visit("/evidence");
  const media = await api(`/runs/${run.runId}/media`);
  assert.match(media.warning, /best effort/u);
  assert.equal(media.playbackRate, 1);
  const recording = media.items.find((item) => item.kind === "video");
  assert.ok(recording, "NATIVE_VIDEO_MISSING");
  assert.ok(
    media.items.some((item) => item.kind === "screenshot"),
    "ACTION_SCREENSHOT_MISSING",
  );
  const video = await fetch(`http://api:4000/api/runs/${run.runId}/media/${recording.index}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(video.ok, "AUTHORIZED_NATIVE_VIDEO_UNAVAILABLE");
  assert.equal(
    Buffer.from(await video.arrayBuffer())
      .subarray(0, 4)
      .toString("hex"),
    "1a45dfa3",
  );
  const mediaDenied = await fetch(
    `http://api:4000/api/runs/${run.runId}/media/${recording.index}`,
    { headers: { authorization: `Bearer ${otherToken}` } },
  );
  assert.ok(!mediaDenied.ok, "CROSS_WORKSPACE_MEDIA_VISIBLE");
  for (const filename of artifactFiles.filter((value) => /\.(?:json|jsonl|html)$/u.test(value)))
    assert.ok(
      !readFileSync(filename, "utf8").includes(credential),
      "ARTIFACT_DISCLOSED_PROTECTED_VALUE",
    );
  assert.match(await (await fetch("http://web:3000/")).text(), /<div id="root">/u);
  await unavailableDashboardJourney({
    api,
    call,
    rpc,
    command,
    project,
    environment,
    credential,
    availableRunId: run.runId,
  });
  console.log("DEPLOYED_BASELINE_BROWSER_PASS");
}

async function unavailableDashboardJourney({
  api,
  call,
  rpc,
  command,
  project,
  environment,
  credential,
  availableRunId,
}) {
  const mission = await call("start_mission", {
    projectId: project.id,
    title: "Recording availability",
    instruction:
      "Inspect a fictional healthy app and distinguish recording storage failure from app behavior.",
    provider: "human",
  });
  const objective = await call("create_objective", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    title: "Unavailable recording",
    completionCriteria: { evidence: "honest" },
    objectiveOrder: 0,
  });
  const flow = await call("create_flow", {
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    name: "Recording availability journey",
  });
  const run = await call("start_run", {
    projectId: project.id,
    missionId: mission.missionId,
    agentSessionId: mission.agentSessionId,
    objectiveId: objective.objectiveId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId: environment.environmentId,
  });
  await command({ kind: "navigate", url: "http://fixture:8080/availability-app" }, run);
  await command({ kind: "observe" }, run);
  let owned;
  for (let attempt = 0; attempt < 20; attempt++) {
    owned = await api(`/runs/${run.runId}`);
    if (owned.evidence.some((item) => item.chunkCount > 0)) break;
    await command({ kind: "observe" }, run);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    owned.evidence.some((item) => item.chunkCount > 0),
    "AVAILABILITY_FIXTURE_HAS_NO_ADMITTED_OBJECT",
  );
  const require = createRequire("/workspace/apps/api/package.json");
  const { Client } = require("pg");
  const database = new Client({
    connectionString: process.env.FIXTURE_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  let receipt;
  try {
    await database.connect();
    await database.query("BEGIN READ ONLY");
    receipt = (
      await database.query(
        "SELECT c.object_key,c.object_digest,c.object_bytes FROM browser_evidence_chunks c JOIN browser_evidence_streams s ON s.id=c.stream_id WHERE s.session_id=$1 ORDER BY c.chunk_index LIMIT 1",
        [run.browserSessionId],
      )
    ).rows[0];
    await database.query("COMMIT");
  } finally {
    await database.end();
  }
  assert.ok(receipt, "AVAILABILITY_RECEIPT_MISSING");
  assert.match(run.browserSessionId, /^[a-f0-9-]{36}$/);
  assert.match(receipt.object_key, /^objects\/[1-9][0-9]*\/[a-f0-9-]{36}\.json$/);
  const root = path.resolve("/evidence", run.browserSessionId, "evidence");
  const filename = path.resolve(root, receipt.object_key);
  assert.ok(filename.startsWith(root + path.sep), "AVAILABILITY_FAULT_SCOPE_INVALID");
  const bytes = readFileSync(filename);
  assert.equal(bytes.length, Number(receipt.object_bytes));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.object_digest);
  const held = `${filename}.fixture-held-${randomUUID()}`;
  renameSync(filename, held);
  try {
    const closed = await command({ kind: "close_for_failure" }, run);
    assert.equal(closed.evidenceState, "incomplete", "MCP_CLOSE_OMITTED_EVIDENCE_STATE");
    assert.equal(closed.evidenceIssue, "object_unavailable", "MCP_CLOSE_OMITTED_EVIDENCE_ISSUE");
    const failed = await api(`/runs/${run.runId}`);
    assert.equal(failed.evidence[0]?.closureIssue, "object_unavailable");
    await call("finalize_run", {
      runId: run.runId,
      ownerGeneration: Number(failed.ownerGeneration),
      outcome: "environment_failure",
      conclusion:
        "Application was reachable; its recording object was intentionally unavailable in the isolated fixture.",
    });
    const report = await rpc("tools/call", {
      name: "publish_mission_report",
      arguments: {
        missionId: mission.missionId,
        agentSessionId: mission.agentSessionId,
        summary: "Unavailable evidence cannot establish success",
        safeReport: {},
      },
    });
    assert.equal(report.isError, true, "UNAVAILABLE_EVIDENCE_AUTHORIZED_A_REPORT");
    assert.ok(!JSON.stringify(report).includes(credential));
    const { chromium } = createRequire("/workspace/packages/praxis/package.json")("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto("http://web:3000/");
      await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Sign in to Scry" });
      await dialog.getByLabel("Work email").fill("fixture-0@example.invalid");
      await dialog.getByLabel("Password", { exact: true }).fill("fixture-ui-signin-only");
      await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
      await page.goto(`http://web:3000/dashboard/runs/${availableRunId}`);
      await page.waitForFunction(
        () => document.querySelector(".native-evidence video")?.readyState >= 2,
      );
      const contrast = await page
        .getByRole("button", { name: "Refresh evidence" })
        .evaluate((button) => ({
          foreground: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
        }));
      assert.notEqual(contrast.foreground, contrast.background, "EVIDENCE_CONTROLS_INVISIBLE");
      assert.equal(contrast.background, "rgb(25, 29, 35)", "EVIDENCE_CONTROLS_NOT_THEMED");
      await page.getByRole("button", { name: /Screenshot.*fill/u }).click();
      await page.waitForFunction(
        () => document.querySelector(".native-evidence img")?.naturalWidth > 0,
      );
      const pixels = await page.locator(".native-evidence img").evaluate((image) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return {
          password: [...context.getImageData(20, 90, 1, 1).data],
          ordinary: [...context.getImageData(400, 300, 1, 1).data],
        };
      });
      assert.deepEqual(pixels.password, [0, 0, 0, 255], "PRODUCTION_NATIVE_PASSWORD_NOT_BLACK");
      assert.deepEqual(pixels.ordinary, [255, 255, 255, 255], "PRODUCTION_NATIVE_UI_OVERBLOCKED");
      const nativeScreenshots = "/evidence/qualification-ui";
      mkdirSync(nativeScreenshots, { recursive: true, mode: 0o700 });
      await page.screenshot({
        path: path.join(nativeScreenshots, "native-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        "NATIVE_EVIDENCE_MOBILE_OVERFLOW",
      );
      await page.screenshot({
        path: path.join(nativeScreenshots, "native-mobile.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`http://web:3000/dashboard/runs/${run.runId}`);
      await page.getByText("Recording unavailable", { exact: true }).waitFor();
      await page
        .getByText(/evidence-storage issue, not a finding about your application/)
        .waitFor();
      const layout = await page
        .locator(".browser-fact")
        .filter({ hasText: "Recording unavailable" })
        .evaluate((row) => {
          const title = row.querySelector("strong"),
            detail = row.querySelector("div > span");
          const state = document.querySelector(".metric.failure > strong"),
            warning = row.querySelector(".status-incomplete");
          return {
            display: getComputedStyle(row).display,
            titleBottom: title?.getBoundingClientRect().bottom,
            detailTop: detail?.getBoundingClientRect().top,
            stateColor: state ? getComputedStyle(state).color : null,
            warningColor: warning ? getComputedStyle(warning).color : null,
          };
        });
      assert.equal(layout.display, "flex", "EVIDENCE_ROW_STYLES_NOT_APPLIED");
      assert.ok(layout.detailTop >= layout.titleBottom, "EVIDENCE_WARNING_COPY_OVERLAPS_TITLE");
      assert.equal(layout.stateColor, "rgb(255, 116, 108)", "FAILED_RUN_USES_SUCCESS_COLOR");
      assert.equal(
        layout.warningColor,
        "rgb(240, 189, 99)",
        "INCOMPLETE_RECORDING_WARNING_NOT_DISTINCT",
      );
      assert.equal(await page.locator("video").count(), 0);
      assert.ok(!(await page.locator("body").innerText()).includes(credential));
      const screenshots = "/evidence/qualification-ui";
      mkdirSync(screenshots, { recursive: true, mode: 0o700 });
      await page.screenshot({
        path: path.join(screenshots, "unavailable-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByText("Recording unavailable", { exact: true }).waitFor();
      // Resize starts the actual off-canvas transition. Inspect its settled
      // state rather than capturing a transient half-drawer as the mobile UI.
      await page.waitForFunction(
        () => document.querySelector(".sidebar")?.getBoundingClientRect().right <= 0,
        undefined,
        { timeout: 5000 },
      );
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("dialog", { name: "Dashboard navigation" }).waitFor();
      await page.waitForFunction(
        () => document.querySelector(".sidebar")?.getBoundingClientRect().left >= 0,
        undefined,
        { timeout: 5000 },
      );
      await page
        .getByRole("dialog", { name: "Dashboard navigation" })
        .getByRole("button", { name: "Close navigation", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelector(".sidebar")?.getBoundingClientRect().right <= 0,
        undefined,
        { timeout: 5000 },
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        false,
        "DASHBOARD_MOBILE_OVERFLOW",
      );
      await page.screenshot({
        path: path.join(screenshots, "unavailable-mobile.png"),
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  } finally {
    renameSync(held, filename);
  }
  assert.equal(
    (await api(`/runs/${run.runId}`)).evidence[0]?.closureIssue,
    "object_unavailable",
    "RESTORED_OBJECT_REWROTE_FAILURE_SEAL",
  );
  console.log("DEPLOYED_AUTHENTICATED_DASHBOARD_PASS");
  console.log(`DASHBOARD_REVIEW_PATH=/dashboard/runs/${run.runId}`);
}
