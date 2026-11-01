import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { allowedTools } from "../src/coordinator.mjs";
test("every promised tool exists in the pinned upstream contract", async () => {
  const upstream = await createConnection(
    { capabilities: ["core", "vision"], webmcp: false },
    async () => {
      throw new Error("Metadata only");
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await upstream.connect(b);
  const client = new Client({ name: "contract-test", version: "experiment" });
  await client.connect(a);
  try {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of allowedTools) assert.ok(names.has(name), name);
    for (const name of [
      "browser_evaluate",
      "browser_run_code_unsafe",
      "browser_console_messages",
      "browser_network_requests",
      "browser_file_upload",
    ])
      assert.equal(allowedTools.has(name), false, name);
    assert.ok(allowedTools.has("browser_mouse_drag_xy"));
  } finally {
    await client.close();
    await upstream.close();
  }
});
