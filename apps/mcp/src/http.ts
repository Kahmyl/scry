#!/usr/bin/env node
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ScryApiClient } from "./api-client.js";
import { createScryMcpServer } from "./server.js";

const host = process.env.MCP_HOST ?? "0.0.0.0";
const port = Number(process.env.MCP_PORT ?? 4100);
const apiBaseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/v1";
const publicApiBaseUrl = process.env.SCRY_PUBLIC_API_BASE_URL ?? apiBaseUrl;
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health" && request.method === "GET") {
    json(response, 200, { status: "ok", transport: "streamable-http" });
    return;
  }

  if (url.pathname !== "/mcp") {
    json(response, 404, { error: "Not found" });
    return;
  }

  if (!originAllowed(request)) {
    json(response, 403, mcpError(-32002, "Request origin is not allowed."));
    return;
  }

  if (request.method !== "POST") {
    json(
      response,
      405,
      mcpError(-32000, "This stateless MCP endpoint accepts POST requests."),
    );
    return;
  }

  const token = bearerToken(request.headers.authorization);
  if (!token) {
    json(response, 401, mcpError(-32001, "A Scry MCP access token is required."));
    return;
  }

  const server = createScryMcpServer(new ScryApiClient(apiBaseUrl, token, publicApiBaseUrl));
  const transport = new StreamableHTTPServerTransport();

  try {
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!response.headersSent) {
      json(response, 500, mcpError(-32603, "Internal MCP server error."));
    }
  } finally {
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
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

function mcpError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
