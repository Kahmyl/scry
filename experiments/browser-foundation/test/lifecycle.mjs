import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = "/results/lifecycle-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const config = {
  root: root + "/store",
  workspace: "lifecycle-lab",
  environments: {
    approved: { allowTesting: true, origins: ["http://diagnosis:8080"] },
    disabled: { allowTesting: false, origins: ["http://disabled.invalid"] },
  },
  secrets: { approved: { password: "Fictional-lifecycle-secret-123" } },
};
await writeFile(root + "/config.json", JSON.stringify(config), { mode: 0o600 });
const client = new Client({ name: "public-lifecycle-qualification", version: "experiment" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  env: { ...process.env, SCRY_CANDIDATE_CONFIG: root + "/config.json" },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const calls = [];
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  calls.push({ name, result });
  return result;
}
const json = (result) => JSON.parse(result.content.find((c) => c.type === "text").text);
try {
  await client.connect(transport);
  const environments = json(await call("scry_list_environments", {})).environments;
  assert.deepEqual(environments, [{ environment: "approved", origins: ["http://diagnosis:8080"] }]);
  assert.equal((await call("scry_start_test", { environment: "disabled" })).isError, true);
  const started = json(await call("scry_start_test", { environment: "approved" }));
  assert.deepEqual(started.availableSecretIds, ["password"]);
  await call("scry_log_finding", {
    runId: started.runId,
    summary:
      "Observed a warning, not necessarily an application defect. Fictional-lifecycle-secret-123",
    classification: "observation",
  });
  const status = json(await call("scry_test_status", { runId: started.runId }));
  assert.equal(status.findings.length, 1);
  assert.equal(status.findings[0].classification, "observation");
  assert.match(status.findings[0].summary, /Observed a warning/);
  assert.doesNotMatch(JSON.stringify(status), /Fictional-lifecycle-secret-123/);
  const finished = json(
    await call("scry_finish_test", { runId: started.runId, outcome: "failed" }),
  );
  assert.equal(finished.state, "failed");
  assert.equal(finished.findings.length, 1);
  assert.equal(finished.evidence.coverage, "complete");
  assert.equal((await call("scry_test_status", { runId: "nonexistent" })).isError, true);
  await writeFile(root + "/results.json", JSON.stringify({ ok: true, calls }, null, 2));
  console.log(JSON.stringify({ root, ok: true }));
} finally {
  await client.close();
}
