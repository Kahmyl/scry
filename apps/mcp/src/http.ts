#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { BrowserApiClient, BrowserApiError } from "./api-client.js";
import { protectedResourceMetadata, authenticationChallenge } from "./oauth-discovery.js";
import { assertBrowserRuntimeAgreement, resolveBrowserRuntime } from "@scry/contracts";
import { createBrowserMcpServer } from "./server.js";

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 4100);
const apiBaseUrl = process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";
const runtimeAdapter = resolveBrowserRuntime(process.env);
const oauthMetadata = protectedResourceMetadata();
const requestCredential = new AsyncLocalStorage<string>();
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

type Session = Readonly<{
  server: ReturnType<typeof createBrowserMcpServer>;
  transport: StreamableHTTPServerTransport;
  authorityDigest: string;
}>;

const sessions = new Map<string, Session>();

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(
      url.pathname,
    ) &&
    request.method === "GET" &&
    oauthMetadata
  )
    return json(response, 200, oauthMetadata);

  if (url.pathname === "/health" && request.method === "GET") {
    try {
      const token = bearerToken(request.headers.authorization) ?? process.env.SCRY_SERVICE_TOKEN;
      if (!token) return json(response, 503, { ready: false, code: "MCP_SERVICE_TOKEN_REQUIRED" });
      const api = new BrowserApiClient(apiBaseUrl, token);
      const health = await api.get<{
        ready: boolean;
        capabilityId: string;
        runtimeAdapter: string;
      }>("/health");
      assertBrowserRuntimeAgreement(health.runtimeAdapter, runtimeAdapter);
      return json(response, health.ready ? 200 : 503, {
        api: health,
        profile: "browser",
        runtimeAdapter,
      });
    } catch {
      return json(response, 503, { ready: false, code: "SCRY_BROWSER_API_UNAVAILABLE" });
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
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin))
    return json(response, 403, mcpError(-32001, "This browser origin is not allowed."));
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
    });
    return response.end();
  }
  if (!["POST", "GET", "DELETE"].includes(request.method ?? ""))
    return json(response, 405, mcpError(-32000, "Unsupported method."));

  const token = bearerToken(request.headers.authorization);
  const unauthorized = () => {
    if (oauthMetadata)
      response.setHeader("WWW-Authenticate", authenticationChallenge(oauthMetadata));
    return json(response, 401, mcpError(-32001, "Connect or sign in to Scry to continue."));
  };
  if (!token) return unauthorized();
  let authority: {
    subject: string;
    workspaceId: string;
    credentialId: string;
    credentialKind: string;
  };
  try {
    authority = await new BrowserApiClient(apiBaseUrl, token).get("/integrations/session");
    if (
      ![
        authority.subject,
        authority.workspaceId,
        authority.credentialId,
        authority.credentialKind,
      ].every((value) => typeof value === "string" && value.length > 0)
    )
      throw new Error("invalid_authority");
  } catch (error) {
    if (error instanceof BrowserApiError && [401, 403].includes(error.status))
      return unauthorized();
    return json(
      response,
      503,
      mcpError(-32000, "Scry could not verify this connection. Try again shortly."),
    );
  }
  const authorityDigest = createHash("sha256").update(JSON.stringify(authority)).digest("hex");
  const suppliedSessionId =
    typeof request.headers["mcp-session-id"] === "string"
      ? request.headers["mcp-session-id"]
      : undefined;
  let session = suppliedSessionId ? sessions.get(suppliedSessionId) : undefined;

  if (suppliedSessionId && !session)
    return json(response, 404, mcpError(-32003, "MCP session not found."));
  if (session && !secureEqual(session.authorityDigest, authorityDigest))
    return json(response, 401, mcpError(-32001, "MCP session authentication mismatch."));
  if (!session && request.method !== "POST")
    return json(response, 400, mcpError(-32004, "Initialize the MCP session first."));

  if (!session) {
    const provider = firstHeader(request.headers["x-scry-agent-provider"]) ?? "unknown";
    const model = firstHeader(request.headers["x-scry-agent-model"]);
    const externalRunId = firstHeader(request.headers["x-scry-external-run-id"]);
    const experimentId = firstHeader(request.headers["x-scry-experiment-id"]);
    const api = new BrowserApiClient(apiBaseUrl, () => requestCredential.getStore(), {
      provider,
      ...(model ? { model } : {}),
      ...(externalRunId ? { externalRunId } : {}),
      ...(experimentId ? { experimentId } : {}),
    });
    const server = createBrowserMcpServer(api);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => {
        sessions.set(sessionId, { server, transport, authorityDigest });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    session = { server, transport, authorityDigest };
    await server.connect(transport as Parameters<typeof server.connect>[0]);
  }

  try {
    await requestCredential.run(token, () => session!.transport.handleRequest(request, response));
  } catch {
    if (!response.headersSent) json(response, 500, mcpError(-32603, "MCP request failed."));
  }
});

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  console.log(
    `Scry Browser MCP listening on http://${host}:${typeof address === "object" && address ? address.port : port}/mcp`,
  );
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
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
