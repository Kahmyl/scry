import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function platformClient() {
  let { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
  let userToken = token,
    renewed = Date.now();
  const api = async (path, body) => {
    if (Date.now() - renewed > 600000) {
      userToken = (await (await fetch("http://fixture:8080/fixture-input")).json()).token;
      renewed = Date.now();
    }
    const response = await fetch("http://api:4000/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + userToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  // A real scoped MCP token avoids the fixture JWT's fifteen-minute expiry in
  // the long-journey test. No authentication expiry is disabled in Scry.
  const access = await api("/mcp-tokens", {
    name: "Isolated journey qualification " + randomUUID(),
  });
  token = access.token;
  let session,
    seq = 0;
  const rpc = async (method, params) => {
    const response = await fetch("http://mcp:4100/mcp", {
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
    assert.ok(response.ok, `MCP transport ${response.status}; inspect, do not repeat mutations`);
    session ??= response.headers.get("mcp-session-id");
    const result = await response.json();
    assert.ok(!result.error, JSON.stringify(result.error));
    return result.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "candidate-complete-path", version: "baseline" },
  });
  const call = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return result;
  };
  const life = async (name, args) => (await call(name, args)).structuredContent;
  const browser = async (run, name, args = {}, actionId = randomUUID(), allowError = false) => {
    const result = await rpc("tools/call", {
      name,
      arguments: { ...args, browserSessionId: run.browserSessionId, actionId },
    });
    let command = result.structuredContent?.command;
    if (!command) {
      const pending = JSON.parse(result.content.find((c) => c.type === "text").text);
      assert.ok(pending.commandId, JSON.stringify(result));
      for (let i = 0; i < 160; i++) {
        command = (await life("get_command", { commandId: pending.commandId })).command;
        if (["failed", "completed"].includes(command.state)) break;
        await sleep(250);
      }
    }
    if (!allowError) {
      assert.equal(command.state, "completed", JSON.stringify(command));
      assert.equal(command.result?.execution, "completed", JSON.stringify(command));
    }
    return { result, command };
  };
  const text = (command) =>
    command.result?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") ?? "";
  const ref = (command, label) => {
    const line = text(command)
      .split("\n")
      .find((line) => line.includes('textbox "' + label + '"'));
    const target = /\[ref=((?:f\d+)?e\d+)\]/.exec(line ?? "")?.[1];
    assert.ok(target, "Missing observed reference: " + label);
    return target;
  };
  const finish = async (run, outcome, conclusion) => {
    const owned = await api("/runs/" + run.runId);
    return life("finalize_run", {
      runId: run.runId,
      ownerGeneration: Number(owned.ownerGeneration),
      outcome,
      conclusion,
    });
  };
  return { api, rpc, call, life, browser, text, ref, finish };
}
