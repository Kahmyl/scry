#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ScryApiClient } from "./api-client.js";
import { createScryMcpServer } from "./server.js";
import { observeMcpRequestRejected } from "./operational-events.js";

const host = process.env.MCP_HOST ?? "0.0.0.0";
const port = Number(process.env.MCP_PORT ?? 4100);
const apiBaseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";
const publicApiBaseUrl = process.env.SCRY_PUBLIC_API_BASE_URL ?? apiBaseUrl;
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

type McpHttpSession = Readonly<{
  server: ReturnType<typeof createScryMcpServer>;
  transport: StreamableHTTPServerTransport;
  tokenDigest: string;
}>;

const mcpSessions = new Map<string, McpHttpSession>();

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health" && request.method === "GET") {
    try {
      const api = new ScryApiClient(apiBaseUrl, process.env.SCRY_SERVICE_TOKEN, publicApiBaseUrl);
      const readiness = await api.get<{ ready: boolean; releaseId: string }>("/ready");
      json(response, readiness.ready ? 200 : 503, {
        status: readiness.ready ? "ok" : "not_ready",
        transport: "streamable-http",
        api: readiness,
      });
    } catch {
      await observeRejection(request, 503, "MCP_API_READINESS_UNAVAILABLE");
      json(response, 503, {
        status: "incompatible",
        transport: "streamable-http",
        reasonCode: "MCP_API_READINESS_UNAVAILABLE",
      });
    }
    return;
  }

  if (url.pathname !== "/mcp") {
    await observeRejection(request, 404, "MCP_ROUTE_NOT_FOUND");
    json(response, 404, { error: "Not found" });
    return;
  }

  if (!originAllowed(request)) {
    await observeRejection(request, 403, "MCP_ORIGIN_NOT_ALLOWED");
    json(response, 403, mcpError(-32002, "Request origin is not allowed."));
    return;
  }

  if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
    await observeRejection(request, 405, "MCP_METHOD_NOT_ALLOWED");
    json(response, 405, mcpError(-32000, "Unsupported MCP HTTP method."));
    return;
  }

  const token = bearerToken(request.headers.authorization);

  if (!token) {
    await observeRejection(request, 401, "MCP_ACCESS_TOKEN_REQUIRED");
    json(response, 401, mcpError(-32001, "A Scry MCP access token is required."));
    return;
  }

  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const suppliedSessionId =
    typeof request.headers["mcp-session-id"] === "string"
      ? request.headers["mcp-session-id"]
      : undefined;

  let session = suppliedSessionId === undefined ? undefined : mcpSessions.get(suppliedSessionId);

  if (suppliedSessionId !== undefined && session === undefined) {
    await observeRejection(request, 404, "MCP_SESSION_NOT_FOUND", suppliedSessionId);
    json(response, 404, mcpError(-32003, "MCP session was not found."));
    return;
  }

  if (session !== undefined && session.tokenDigest !== tokenDigest) {
    await observeRejection(request, 401, "MCP_SESSION_AUTHENTICATION_MISMATCH", suppliedSessionId);
    json(response, 401, mcpError(-32001, "MCP session authentication does not match."));
    return;
  }

  if (session === undefined && request.method !== "POST") {
    await observeRejection(request, 400, "MCP_INITIALIZED_SESSION_REQUIRED");
    json(response, 400, mcpError(-32004, "An initialized MCP session is required."));
    return;
  }

  if (session === undefined) {
    const server = createScryMcpServer(new ScryApiClient(apiBaseUrl, token, publicApiBaseUrl));

    let initializedSession: McpHttpSession | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        initializedSession = {
          server,
          transport,
          tokenDigest,
        };

        mcpSessions.set(sessionId, initializedSession);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;

      if (sessionId !== undefined) mcpSessions.delete(sessionId);
    };

    session = {
      server,
      transport,
      tokenDigest,
    };

    try {
      await server.connect(transport as Parameters<typeof server.connect>[0]);

      await transport.handleRequest(request, response);
    } catch {
      await observeRejection(request, 500, "MCP_REQUEST_FAILED");

      if (!response.headersSent)
        json(response, 500, mcpError(-32603, "Internal MCP server error."));
    }

    return;
  }

  try {
    await session.transport.handleRequest(request, response);
  } catch {
    await observeRejection(request, 500, "MCP_REQUEST_FAILED", suppliedSessionId);

    if (!response.headersSent) json(response, 500, mcpError(-32603, "Internal MCP server error."));
  }
});

httpServer.listen(port, host, () => {
  console.log(`Scry MCP Streamable HTTP listening on http://${host}:${port}/mcp`);
});

function originAllowed(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function bearerToken(value: string | undefined) {
  if (!value) return undefined;
  const [scheme, token, extra] = value.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && !extra ? token : undefined;
}

function observeRejection(
  request: IncomingMessage,
  status: number,
  reasonCode: string,
  sessionId?: string,
) {
  const correlationId = firstHeader(request.headers["x-correlation-id"]);
  return observeMcpRequestRejected({
    reasonCode,
    status,
    ...(request.method ? { method: request.method } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function mcpError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
