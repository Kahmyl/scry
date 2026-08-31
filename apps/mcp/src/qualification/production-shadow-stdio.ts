/** Local non-authoritative qualification: actual scoped client and production tools. */
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ScryApiClient } from "../api-client.js";
import { Q5ScopedApiClient } from "./q5-scoped-api-client.js";
import { createQ5McpServer } from "./q5-server.js";
const config = JSON.parse(readFileSync(process.env.SCRY_SHADOW_CONNECTION!, "utf8"));
if (
  new URL(config.apiBaseUrl).hostname !== "127.0.0.1" ||
  config.scope.attemptId !== null ||
  config.scope.state !== "preflight"
)
  throw new Error("LOCAL_NON_AUTHORITATIVE_QUALIFICATION_REQUIRED");
const identity = { provider: "codex-production-shadow" };
const control = new ScryApiClient(
  config.apiBaseUrl,
  config.serviceToken,
  config.apiBaseUrl,
  identity,
);
const client = new Q5ScopedApiClient(
  config.apiBaseUrl,
  config.serviceToken,
  config.apiBaseUrl,
  identity,
  config.scope,
  control,
);
await createQ5McpServer(client).connect(new StdioServerTransport());
