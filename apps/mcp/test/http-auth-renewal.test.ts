import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("authenticated MCP transport renewal", () => {
  const revoked = new Set<string>();
  const seen: string[] = [];
  let child: ChildProcess, api: ReturnType<typeof createServer>, base: string;
  beforeAll(async () => {
    api = createServer((request, response) => {
      const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
      if (revoked.has(token) || !["old", "renewed", "other"].includes(token)) {
        response.writeHead(401, { "content-type": "application/json" });
        return response.end('{"message":"Reconnect"}');
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/integrations/session")
        return response.end(
          JSON.stringify({
            subject: "same-user",
            workspaceId: "same-workspace",
            credentialId: token === "other" ? "another-connection" : "one-connection",
            credentialKind: "mcp",
          }),
        );
      if (request.url === "/api/projects") {
        seen.push(token);
        return response.end(
          JSON.stringify([
            { id: "00000000-0000-4000-8000-000000000001", name: "Fictional project" },
          ]),
        );
      }
      response.writeHead(404);
      response.end("{}");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("fixture_address");
    child = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        MCP_HOST: "127.0.0.1",
        MCP_PORT: "0",
        SCRY_API_BASE_URL: `http://127.0.0.1:${address.port}/api`,
        SCRY_BROWSER_ADAPTER: "playwright_mcp",
        SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED: "true",
        SCRY_OAUTH_ENABLED: "true",
        SCRY_OAUTH_ISSUER: "https://scry.example/oauth",
        SCRY_OAUTH_RESOURCE: "https://scry.example/mcp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP fixture did not start")), 10000);
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("MCP fixture exited"));
      });
      child.stdout!.on("data", (chunk) => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/mcp/u);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
    });
  });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  const rpc = (token: string, body: unknown, session?: string) =>
    fetch(base, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  const initialize = (token: string) =>
    rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fictional-client", version: "test" },
      },
    });
  it("advertises OAuth and rejects invalid credentials before initialization", async () => {
    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", base));
    expect((await metadata.json()).resource).toBe("https://scry.example/mcp");
    const denied = await initialize("invalid");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });
  it("retains session identity on renewal and forwards the current request token, not the expired token", async () => {
    const initial = await initialize("old");
    expect(initial.status).toBe(200);
    const session = initial.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();
    await initial.json();
    const listed = await rpc(
      "old",
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
      session,
    );
    const tools = (await listed.json()).result.tools as Array<{ _meta?: Record<string, unknown> }>;
    expect(tools.length).toBeGreaterThan(10);
    expect(
      tools.every(
        (tool) =>
          JSON.stringify(tool._meta?.securitySchemes) ===
          JSON.stringify([{ type: "oauth2", scopes: ["scry:testing"] }]),
      ),
    ).toBe(true);
    revoked.add("old");
    const result = await rpc(
      "renewed",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      session,
    );
    expect(result.status, await result.clone().text()).toBe(200);
    expect((await result.json()).result.isError).not.toBe(true);
    expect(seen.at(-1)).toBe("renewed");
    const different = await rpc(
      "other",
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      session,
    );
    expect(different.status).toBe(401);
    revoked.add("renewed");
    expect(
      (await rpc("renewed", { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, session))
        .status,
    ).toBe(401);
  });
  it("rejects an unapproved browser origin", async () => {
    const response = await fetch(base, {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});
