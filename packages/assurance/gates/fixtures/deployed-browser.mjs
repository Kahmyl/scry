import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

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
  createServer((request, response) => {
    const url = new URL(request.url, "http://fixture:8080");
    response.setHeader("content-type", "application/json");
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
  const command = async (input) => {
    let result = await call("command", { browserSessionId: run.browserSessionId, command: input });
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
  const publicationPath = artifactFiles.find(
    (filename) => path.basename(filename) === "publication.json",
  );
  assert.ok(publicationPath, "SANITIZED_REPLAY_PUBLICATION_MISSING");
  const publication = JSON.parse(readFileSync(publicationPath, "utf8"));
  assert.equal(publication.complete, true);
  assert.equal(publication.networkRequests, 0);
  assert.ok(
    publication.frameCount > 0 &&
      publication.visibleFrameCount >= Math.ceil(publication.frameCount / 2),
    "REPLAY_FRAMES_INCOMPLETE",
  );
  assert.ok(
    readFileSync(path.join(path.dirname(publicationPath), "sanitized-replay.webm")).length > 0,
    "REPLAY_VIDEO_MISSING",
  );
  for (const filename of artifactFiles.filter((value) => /\.(?:json|jsonl|html)$/u.test(value)))
    assert.ok(
      !readFileSync(filename, "utf8").includes(credential),
      "ARTIFACT_DISCLOSED_PROTECTED_VALUE",
    );
  assert.match(await (await fetch("http://web:3000/")).text(), /<div id="root">/u);
  console.log("DEPLOYED_BASELINE_BROWSER_PASS");
}
