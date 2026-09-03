#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { BrowserV2ApiClient } from "./browser-v2-api-client.js";
import { createBrowserV2McpServer } from "./browser-v2-server.js";

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 4100);
const apiBaseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";

type Session = Readonly<{
  server: ReturnType<typeof createBrowserV2McpServer>;
  transport: StreamableHTTPServerTransport;
  tokenDigest: string;
}>;

const sessions = new Map<string, Session>();

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health" && request.method === "GET") {
    try {
      const token = bearerToken(request.headers.authorization) ?? process.env.SCRY_SERVICE_TOKEN;
      if (!token) return json(response, 503, { ready: false, code: "MCP_SERVICE_TOKEN_REQUIRED" });
      const api = new BrowserV2ApiClient(apiBaseUrl, token);
      const health = await api.get<{ ready: boolean; capabilityVersion: string }>("/v2/health");
      return json(response, health.ready ? 200 : 503, { api: health, profile: "browser-v2" });
    } catch {
      return json(response, 503, { ready: false, code: "BROWSER_V2_API_UNAVAILABLE" });
    }
  }

  if (
    ["/agent-lab/heartbeat", "/agent-lab/terminate"].includes(url.pathname) &&
    request.method === "POST"
  ) {
    return json(response, 200, { settled: true, scope: "evaluator_process" });
  }

  if (url.pathname === "/agent-lab/provider-request" && request.method === "POST") {
    return json(response, 200, { recorded: false, scope: "non_authoritative_evaluation" });
  }

  if (url.pathname !== "/mcp") return json(response, 404, mcpError(-32003, "Not found."));
  if (!["POST", "GET", "DELETE"].includes(request.method ?? ""))
    return json(response, 405, mcpError(-32000, "Unsupported method."));

  const token = bearerToken(request.headers.authorization);
  if (!token) return json(response, 401, mcpError(-32001, "A bearer token is required."));
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const suppliedSessionId =
    typeof request.headers["mcp-session-id"] === "string"
      ? request.headers["mcp-session-id"]
      : undefined;
  let session = suppliedSessionId ? sessions.get(suppliedSessionId) : undefined;

  if (suppliedSessionId && !session)
    return json(response, 404, mcpError(-32003, "MCP session not found."));
  if (session && !secureEqual(session.tokenDigest, tokenDigest))
    return json(response, 401, mcpError(-32001, "MCP session authentication mismatch."));
  if (!session && request.method !== "POST")
    return json(response, 400, mcpError(-32004, "Initialize the MCP session first."));

  if (!session) {
    const provider = firstHeader(request.headers["x-scry-agent-provider"]) ?? "unknown";
    const model = firstHeader(request.headers["x-scry-agent-model"]);
    const externalRunId = firstHeader(request.headers["x-scry-external-run-id"]);
    const experimentId = firstHeader(request.headers["x-scry-experiment-id"]);
    const api = new BrowserV2ApiClient(apiBaseUrl, token, {
      provider,
      ...(model ? { model } : {}),
      ...(externalRunId ? { externalRunId } : {}),
      ...(experimentId ? { experimentId } : {}),
    });
    const server = createBrowserV2McpServer(api);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => {
        sessions.set(sessionId, { server, transport, tokenDigest });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    session = { server, transport, tokenDigest };
    await server.connect(transport as Parameters<typeof server.connect>[0]);
  }

  try {
    await session.transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) json(response, 500, mcpError(-32603, "MCP request failed."));
  }
});

httpServer.listen(port, host, () => {
  console.log(`Scry Browser v2 MCP listening on http://${host}:${port}/mcp`);
});

function bearerToken(value: string | undefined) {
  if (!value) return undefined;
  const [scheme, token, extra] = value.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && !extra ? token : undefined;
}

function firstHeader(value: string | string[] | undefined) {
  const result = Array.isArray(value) ? value[0] : value;
  return result && result.length <= 200 && !/[\r\n]/u.test(result) ? result : undefined;
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mcpError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
