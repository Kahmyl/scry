// Read-only external discovery check. No repo knowledge is sent to the client.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const root = "/results/mcp-report-guidance-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const receipts = [];
for (let trial = 0; trial < 2; trial++) {
  let session;
  const rpc = async (method, params) => {
    const response = await fetch("http://mcp:4100/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    session ??= response.headers.get("mcp-session-id");
    const payload = await response.json();
    assert.ok(!payload.error, JSON.stringify(payload.error));
    return payload.result;
  };
  try {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fresh-external-report-reader", version: "baseline" },
    });
    const instructions = initialized.instructions;
    assert.ok(instructions.includes("Customer reports describe the tested application, not Scry"));
    for (const term of [
      "safeReport.presentation",
      "not_tested",
      "inconclusive",
      "No automatic retry",
      "operator diagnostics",
      "Example report payload",
    ])
      assert.ok(instructions.includes(term), term);
    const tools = (await rpc("tools/list", {})).tools;
    const report = tools.find((t) => t.name === "publish_mission_report");
    assert.ok(report.inputSchema.properties.safeReport.properties.presentation);
    const schema = JSON.stringify(report.inputSchema.properties.safeReport.properties.presentation);
    for (const field of [
      '"matched_expectation"',
      '"different_from_expectation"',
      '"inconclusive"',
      '"not_tested"',
      '"expected"',
      '"actual"',
      '"artifactId"',
    ])
      assert.ok(schema.includes(field), field);
    const projects = await rpc("tools/call", { name: "list_projects", arguments: {} });
    assert.ok(!projects.isError, "Customer principal could not read its project scope");
    const invalid = await rpc("tools/call", {
      name: "publish_mission_report",
      arguments: {
        missionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        summary: "Must not become an app result",
        safeReport: {
          presentation: {
            subject: "application",
            checks: [{ title: "Browser tool", actual: "Tool returned", status: "passed" }],
          },
        },
      },
    });
    assert.equal(invalid.isError, true);
    receipts.push({
      trial,
      instructions,
      reportTool: report,
      authenticatedProjectDiscovery: true,
      invalidToolVerdictRejected: true,
    });
  } finally {
    if (session) {
      const closed = await fetch("http://mcp:4100/mcp", {
        method: "DELETE",
        headers: {
          authorization: "Bearer " + token,
          "mcp-session-id": session,
          "mcp-protocol-version": "2025-03-26",
        },
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(closed.status, 200);
    }
  }
}
await writeFile(
  root + "/result.json",
  JSON.stringify(
    {
      kind: "fresh_customer_http_mcp_discovery_not_agent_behavioral_acceptance",
      receipts,
      passed: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    root,
    freshConnections: receipts.length,
    instructionsReceived: true,
    structuredReportSchemaReceived: true,
    invalidToolVerdictRejected: true,
    passed: true,
  }),
);
