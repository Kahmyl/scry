import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { migrateBrowserBaseline } from "../scripts/baseline-migration.js";
import { Database } from "../src/infrastructure/database.js";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { AuthService } from "../src/auth/auth.service.js";
import { IdentityRepository } from "../src/auth/repositories/identity.repository.js";
import { McpTokenRepository } from "../src/auth/repositories/mcp-token.repository.js";
import { McpTokensController } from "../src/auth/mcp-tokens.controller.js";
import { ConnectionsController } from "../src/auth/oauth/connections.controller.js";
import { ConnectionsRepository } from "../src/auth/oauth/connections.repository.js";
import { OAuthService } from "../src/auth/oauth/oauth.service.js";
import { mountOAuth } from "../src/auth/oauth/mount.js";
import { providerAdapter } from "../src/auth/oauth/provider-adapter.js";
import { BrowserProtectedValueCipher } from "@scry/veil";
import { BrowserProjectController } from "../src/browser-execution/controllers/browser-project.controller.js";
import { BrowserProjectRepository } from "../src/browser-execution/repositories/browser-project.repository.js";

const adminUrl = process.env.SCRY_OAUTH_TEST_DATABASE_URL;
const live = adminUrl ? describe : describe.skip;

@Module({
  controllers: [ConnectionsController, McpTokensController, BrowserProjectController],
  providers: [
    Database,
    IdentityRepository,
    AuthService,
    OAuthService,
    ConnectionsRepository,
    McpTokenRepository,
    BrowserProjectRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class OAuthFixtureModule {}

class BrowserCookies {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(new URL(path, this.base), {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const entry of response.headers.getSetCookie()) {
      const [pair] = entry.split(";");
      const at = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  }
}

live("workspace-bound OAuth account linking", () => {
  let app: NestFastifyApplication, database: Database, admin: pg.Client;
  let base: string, dashboardToken: string, otherToken: string;
  let identityServer: ReturnType<typeof createServer>;
  let localDatabase: string;
  const savedEnv = { ...process.env };
  const workspaceId = randomUUID(),
    otherWorkspaceId = randomUUID();
  const subject = randomUUID(),
    otherSubject = randomUUID();
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    localDatabase = `scry_oauth_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${localDatabase}"`);
    const connection = new URL(adminUrl!);
    connection.pathname = `/${localDatabase}`;
    process.env.DATABASE_URL = connection.href;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    // Rehearse the additive upgrade, not only a fresh schema. The preceding
    // baseline and its existing application records must survive unchanged.
    const previous = await mkdtemp(join(tmpdir(), "scry-oauth-schema-"));
    try {
      const catalog = new URL("../baseline-schema/", import.meta.url);
      await mkdir(join(previous, "compatibility"));
      await copyFile(
        new URL("compatibility/legacy-browser-generation.sql", catalog),
        join(previous, "compatibility/legacy-browser-generation.sql"),
      );
      for (const file of await readdir(catalog))
        if (/^00(?:0[1-9]|1[0-6])-.*\.sql$/u.test(file))
          await copyFile(new URL(file, catalog), join(previous, file));
      await migrateBrowserBaseline({
        confirmation: "CREATE_EMPTY_BASELINE",
        databaseUrl: connection.href,
        expectedDatabase: localDatabase,
        directory: previous,
      });
    } finally {
      await rm(previous, { recursive: true });
    }
    const keys = await generateKeyPair("RS256", { extractable: true });
    const publicKey = {
      ...(await exportJWK(keys.publicKey)),
      kid: "fixture-identity",
      alg: "RS256",
    };
    identityServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise<void>((resolve) => identityServer.listen(0, "127.0.0.1", resolve));
    const identityAddress = identityServer.address();
    if (!identityAddress || typeof identityAddress === "string") throw new Error("fixture_address");
    process.env.SUPABASE_URL = `http://127.0.0.1:${identityAddress.port}`;
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const address = portServer.address();
    if (!address || typeof address === "string") throw new Error("fixture_address");
    base = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    process.env.SCRY_OAUTH_ENABLED = "true";
    process.env.SCRY_OAUTH_ISSUER = `${base}/oauth`;
    process.env.SCRY_OAUTH_RESOURCE = `${base}/mcp`;
    process.env.SCRY_OAUTH_COOKIE_KEYS_JSON = JSON.stringify([
      randomBytes(48).toString("base64url"),
    ]);
    process.env.SCRY_OAUTH_JWKS_JSON = JSON.stringify({
      keys: [
        { ...(await exportJWK(keys.privateKey)), kid: "fixture-oauth", alg: "RS256", use: "sig" },
      ],
    });
    const jwt = (sub: string, email: string) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-identity" })
        .setSubject(sub)
        .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
        .setAudience("authenticated")
        .setExpirationTime("1h")
        .sign(keys.privateKey);
    dashboardToken = await jwt(subject, "owner@example.test");
    otherToken = await jwt(otherSubject, "other@example.test");
    app = await NestFactory.create<NestFastifyApplication>(
      OAuthFixtureModule,
      new FastifyAdapter(),
      { logger: false },
    );
    database = app.get(Database);
    const userId = randomUUID(),
      otherUserId = randomUUID();
    await database.query(
      "INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,'owner@example.test'),($3,$4,'other@example.test')",
      [userId, subject, otherUserId, otherSubject],
    );
    await database.query(
      "INSERT INTO workspaces(id,name,slug) VALUES($1,'Studio workspace',$2),($3,'Other workspace',$4)",
      [workspaceId, randomUUID(), otherWorkspaceId, randomUUID()],
    );
    await database.query(
      "INSERT INTO workspace_memberships(user_id,workspace_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
      [userId, workspaceId, otherUserId, otherWorkspaceId],
    );
    await database.query(
      "INSERT INTO projects(workspace_id,name) VALUES($1,'Studio test app'),($2,'Other test app')",
      [workspaceId, otherWorkspaceId],
    );
    await migrateBrowserBaseline({
      confirmation: "CREATE_EMPTY_BASELINE",
      databaseUrl: connection.href,
      expectedDatabase: localDatabase,
    });
    expect(
      (await database.query("SELECT name FROM projects ORDER BY name")).rows.map((row) => row.name),
    ).toEqual(["Other test app", "Studio test app"]);
    await mountOAuth(app);
    await app.listen(address.port, "127.0.0.1");
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => identityServer?.close(() => resolve()) ?? resolve());
    if (admin) {
      if (localDatabase && /^scry_oauth_[a-f0-9]{32}$/u.test(localDatabase))
        await admin.query(`DROP DATABASE "${localDatabase}"`);
      await admin.end();
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  let renewalClient: { client_id: string; client_secret?: string } | undefined;
  async function begin(
    scope = "scry:testing offline_access",
    authentication = "none",
    reuseRenewalClient = false,
  ) {
    let client = reuseRenewalClient ? renewalClient : undefined;
    if (!client) {
      const registered = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Fictional test assistant",
          redirect_uris: ["http://127.0.0.1:49199/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: authentication,
          // Standard MCP SDK clients include the discovered/requested scope in DCR.
          scope: "scry:testing offline_access",
        }),
      });
      client = (await registered.json()) as { client_id: string; client_secret?: string };
      expect(registered.status).toBe(201);
      if (reuseRenewalClient) renewalClient = client;
    }
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:49199/callback",
      response_type: "code",
      scope,
      resource: `${base}/mcp`,
      state: "fictional-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const browser = new BrowserCookies(base);
    const response = await browser.fetch(`/oauth/authorize?${params}`);
    expect([302, 303], await response.text()).toContain(response.status);
    const location = response.headers.get("location")!;
    expect(location).toContain("/api/integrations/authorize/");
    const uid = location.split("/").at(-1)!;
    // Follow the same hand-off a real browser follows. A Location header on a
    // 200 response leaves users on a blank page instead of opening consent.
    const handoff = await browser.fetch(location);
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("location")).toBe(`${base}/connect/authorize/${uid}`);
    expect(handoff.headers.get("cache-control")).toBe("no-store");
    expect(handoff.headers.get("referrer-policy")).toBe("no-referrer");
    const details = await browser.fetch(`/api/integrations/authorize/${uid}/details`, {
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(details.status, await details.clone().text()).toBe(200);
    const info = (await details.json()) as { workspaces: { id: string }[] };
    expect(info.workspaces.map((item) => item.id)).toEqual([workspaceId]);
    return { client, verifier, uid, browser, authentication };
  }
  async function approve(flow: Awaited<ReturnType<typeof begin>>, workspace = workspaceId) {
    const response = await flow.browser.fetch(`/api/integrations/authorize/${flow.uid}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dashboardToken}`,
        origin: base,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve", workspaceId: workspace }),
    });
    if (response.status !== 201) return { response, code: "" };
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const resumed = await flow.browser.fetch(redirectTo);
    const callback = new URL(resumed.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("fictional-state");
    expect(callback.searchParams.get("error"), await resumed.text()).toBeNull();
    return { response, code: callback.searchParams.get("code")! };
  }
  const token = (fields: Record<string, string>) =>
    fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  const exchange = (
    flow: Awaited<ReturnType<typeof begin>>,
    code: string,
    verifier = flow.verifier,
  ) =>
    token({
      grant_type: "authorization_code",
      client_id: flow.client.client_id,
      redirect_uri: "http://127.0.0.1:49199/callback",
      code,
      code_verifier: verifier,
      resource: `${base}/mcp`,
      ...(flow.authentication === "client_secret_post"
        ? { client_secret: flow.client.client_secret! }
        : {}),
    });

  async function linked(reuseClient = true) {
    // One actual registration can own many independent consent grants. Reuse
    // it for renewal experiments; do not weaken the production DCR rate limit.
    const flow = await begin("scry:testing", "none", reuseClient);
    const { code } = await approve(flow);
    const response = await exchange(flow, code);
    expect(response.status).toBe(200);
    const issued = await response.json();
    const fields = {
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: issued.refresh_token,
      resource: `${base}/mcp`,
    };
    const renew = (patch: Record<string, string> = {}) => token({ ...fields, ...patch });
    const refresh = await app.get(OAuthService).provider!.RefreshToken.find(issued.refresh_token);
    const connection = (
      await database.query(
        "SELECT id,grant_hash,user_id,workspace_id FROM oauth_connections WHERE grant_hash=$1",
        [createHash("sha256").update(refresh!.grantId!).digest("hex")],
      )
    ).rows[0]!;
    return { flow, issued, fields, renew, connection };
  }

  const projectStatus = async (access: string) =>
    (await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${access}` } }))
      .status;

  async function renewalProcess(crash: boolean | "after_commit_drop" = false) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/oauth-renewal-process.ts", import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          SCRY_OAUTH_FIXTURE_CRASH:
            crash === true ? "before_receipt" : crash === "after_commit_drop" ? crash : "",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("FICTIONAL_PROCESS_TIMEOUT")), 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("FICTIONAL_PROCESS_EXITED"));
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("FICTIONAL_PROCESS_FAILED"));
        });
        lines.once("line", (line) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line).port);
          } catch {
            reject(new Error("FICTIONAL_PROCESS_OUTPUT"));
          }
        });
      });
      return {
        child,
        endpoint: `http://127.0.0.1:${port}/oauth/token`,
        async close() {
          lines.close();
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "exit");
            child.kill("SIGTERM");
            await closed;
          }
        },
      };
    } catch (error) {
      lines.close();
      child.kill("SIGKILL");
      throw error;
    }
  }

  const postRenewal = (endpoint: string, fields: Record<string, string>) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(10000),
    });

  it("advertises the resource scope for standard registration and refuses unrelated scopes", async () => {
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server/oauth`);
    const metadata = await discovery.json();
    expect(metadata.scopes_supported).toContain("scry:testing");
    const refused = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Fictional unsupported-scope client",
        redirect_uris: ["http://127.0.0.1:49199/callback"],
        token_endpoint_auth_method: "none",
        scope: "scry:testing unrelated:admin",
      }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("invalid_client_metadata");
  });

  it("refreshes a testing-only grant with the scopes advertised to MCP clients, without expanding access", async () => {
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server/oauth`);
    const metadata = await discovery.json();
    expect(discovery.headers.get("cache-control")).toBe("no-store");
    const oidc = await (await fetch(`${base}/oauth/.well-known/openid-configuration`)).json();
    expect(oidc.scopes_supported).toEqual(
      expect.arrayContaining(["openid", "offline_access", "scry:testing"]),
    );
    for (const field of [
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
      "jwks_uri",
    ])
      expect(metadata[field]).toBe(oidc[field]);
    const flow = await begin("scry:testing");
    const { code } = await approve(flow);
    const response = await exchange(flow, code);
    const issued = await response.json();
    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: issued.refresh_token,
      scope: metadata.scopes_supported.join(" "),
    });
    const renewed = await refreshed.json();
    expect(refreshed.status, renewed.error_description).toBe(200);
    expect(metadata.scopes_supported).toEqual(["scry:testing"]);
    expect(renewed.scope).toBe("scry:testing");
    const projects = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${renewed.access_token}` },
    });
    expect(projects.status).toBe(200);
    expect((await projects.json()).map((project: { name: string }) => project.name)).toEqual([
      "Studio test app",
    ]);
    for (const scope of [
      "scry:testing openid",
      "scry:testing offline_access",
      "scry:testing unrelated:admin",
    ]) {
      const denied = await token({
        grant_type: "refresh_token",
        client_id: flow.client.client_id,
        refresh_token: renewed.refresh_token,
        resource: `${base}/mcp`,
        scope,
      });
      expect(denied.status).toBe(400);
      expect((await denied.json()).error).toBe("invalid_scope");
    }
    const stillValid = await token({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: renewed.refresh_token,
      scope: "scry:testing",
    });
    expect(stillValid.status).toBe(200);
    expect((await stillValid.json()).scope).toBe("scry:testing");
  });

  it("refuses malformed browser hand-offs without redirecting", async () => {
    const response = await fetch(`${base}/api/integrations/authorize/invalid`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(response.headers.has("location")).toBe(false);
  });

  it("approves only the chosen workspace, renews access and disconnects existing access and refresh tokens", async () => {
    const flow = await begin("scry:testing");
    const { code } = await approve(flow);
    const exchanged = await exchange(flow, code);
    const issued = (await exchanged.json()) as { access_token: string; refresh_token: string };
    expect(exchanged.status, JSON.stringify(issued)).toBe(200);
    const projects = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(projects.status, await projects.clone().text()).toBe(200);
    expect(((await projects.json()) as { name: string }[]).map((item) => item.name)).toEqual([
      "Studio test app",
    ]);
    expect(
      (
        await fetch(`${base}/api/mcp-tokens`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/integrations/connections`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(403);
    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: issued.refresh_token,
      scope: "scry:testing",
      resource: `${base}/mcp`,
    });
    const renewed = (await refreshed.json()) as typeof issued;
    expect(refreshed.status, JSON.stringify(renewed)).toBe(200);
    expect(renewed.access_token).not.toBe(issued.access_token);
    const connections = await fetch(`${base}/api/integrations/connections`, {
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    const row = (
      (await connections.json()) as { connections: { id: string; lastUsedAt: string }[] }
    ).connections[0]!;
    expect(row.lastUsedAt).toBeTruthy();
    expect(
      (
        await fetch(`${base}/api/integrations/connections/${row.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/integrations/connections/${row.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${dashboardToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${renewed.access_token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: renewed.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
  }, 20000);
  it("rejects bad PKCE and concurrent authorization-code replay", async () => {
    const bad = await begin();
    const first = await approve(bad);
    expect((await exchange(bad, first.code, randomBytes(32).toString("base64url"))).status).toBe(
      400,
    );
    const good = await begin();
    const second = await approve(good);
    const statuses = (await Promise.all([exchange(good, second.code), exchange(good, second.code)]))
      .map((response) => response.status)
      .sort();
    expect(statuses).toEqual([200, 400]);
  }, 20000);
  it("refuses a workspace outside membership and a decision without the initiating browser cookie", async () => {
    const flow = await begin();
    const missing = await fetch(`${base}/api/integrations/authorize/${flow.uid}/details`, {
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    expect(missing.status).toBe(400);
    expect((await approve(flow, otherWorkspaceId)).response.status).toBe(403);
  }, 20000);
  it("cancels without granting access", async () => {
    const flow = await begin();
    const response = await flow.browser.fetch(`/api/integrations/authorize/${flow.uid}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dashboardToken}`,
        origin: base,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "deny" }),
    });
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const resumed = await flow.browser.fetch(redirectTo);
    expect(new URL(resumed.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
  }, 20000);
  it("rejects wrong-resource and wrong-callback exchanges and cross-origin approval", async () => {
    const flow = await begin();
    const forged = await flow.browser.fetch(`/api/integrations/authorize/${flow.uid}/decision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dashboardToken}`,
        origin: "https://untrusted.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve", workspaceId }),
    });
    expect(forged.status).toBe(403);
    const { code } = await approve(flow);
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: flow.client.client_id,
          redirect_uri: "http://127.0.0.1:49199/callback",
          code,
          code_verifier: flow.verifier,
          resource: "https://untrusted.example/mcp",
        })
      ).status,
    ).toBe(400);
    const next = await begin();
    const approved = await approve(next);
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: next.client.client_id,
          redirect_uri: "http://127.0.0.1:49199/different",
          code: approved.code,
          code_verifier: next.verifier,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
  }, 20000);
  it("rechecks current membership and never exposes stored provider tokens as plaintext", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const stored = await database.query(
      "SELECT ciphertext,nonce,key_id FROM oauth_provider_records WHERE model='AccessToken'",
    );
    expect(stored.rowCount).toBeGreaterThan(0);
    expect(
      stored.rows.every(
        (row) =>
          !row.ciphertext.toString().includes(issued.access_token) &&
          row.nonce.length === 12 &&
          row.key_id,
      ),
    ).toBe(true);
    await database.query("DELETE FROM workspace_memberships WHERE workspace_id=$1", [workspaceId]);
    try {
      expect(
        (
          await fetch(`${base}/api/projects`, {
            headers: { authorization: `Bearer ${issued.access_token}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await database.query(
        "INSERT INTO workspace_memberships(user_id,workspace_id,role) SELECT id,$1,'owner' FROM app_users WHERE supabase_user_id=$2",
        [workspaceId, subject],
      );
    }
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(200);
  }, 20000);
  it("refuses expired grants before cleanup and reports that a reconnection is needed", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const hash = createHash("sha256").update(issued.access_token).digest("hex");
    const row = (
      await database.query(
        "SELECT grant_hash FROM oauth_provider_records WHERE model='AccessToken' AND id_hash=$1",
        [hash],
      )
    ).rows[0]!;
    await database.query(
      "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='Grant' AND id_hash=$1",
      [row.grant_hash],
    );
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(401);
    const response = await fetch(`${base}/api/integrations/connections`, {
      headers: { authorization: `Bearer ${dashboardToken}` },
    });
    const connections = (
      (await response.json()) as { connections: { id: string; expired: boolean }[] }
    ).connections;
    expect(connections[0]!.expired).toBe(true);
    await app.get(OAuthService).sweepExpired();
    expect(
      (
        await database.query(
          "SELECT id_hash FROM oauth_provider_records WHERE model='Grant' AND id_hash=$1",
          [row.grant_hash],
        )
      ).rowCount,
    ).toBe(0);
  }, 20000);
  it("survives an API/provider restart using durable keys, registrations and refresh tokens", async () => {
    const flow = await begin("scry:testing");
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const refresh = await app.get(OAuthService).provider!.RefreshToken.find(issued.refresh_token);
    await database.query(
      "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='Session' AND uid_hash=$1",
      [createHash("sha256").update(refresh!.sessionUid!).digest("hex")],
    );
    await app.close();
    app = await NestFactory.create<NestFastifyApplication>(
      OAuthFixtureModule,
      new FastifyAdapter(),
      { logger: false },
    );
    database = app.get(Database);
    await mountOAuth(app);
    await app.listen(Number(new URL(base).port), "127.0.0.1");
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: issued.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(200);
  }, 20000);
  it("keeps a testing-only connection usable after its consent browser session expires", async () => {
    const flow = await begin("scry:testing");
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const provider = app.get(OAuthService).provider!;
    const refresh = await provider.RefreshToken.find(issued.refresh_token);
    expect(refresh?.sessionUid).toBeTruthy();
    // Expire only this synthetic consent browser session, not the approved
    // connection grant or either token's own lifetime.
    await database.query(
      "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='Session' AND uid_hash=$1",
      [createHash("sha256").update(refresh!.sessionUid!).digest("hex")],
    );
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(200);
    let current = issued;
    for (let renewal = 0; renewal < 3; renewal++) {
      // Exercise repeated access-token expiry without a wall-clock wait or a
      // new consent interaction. The actual HTTP token/resource paths run.
      await database.query(
        "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='AccessToken' AND id_hash=$1",
        [createHash("sha256").update(current.access_token).digest("hex")],
      );
      expect(
        (
          await fetch(`${base}/api/projects`, {
            headers: { authorization: `Bearer ${current.access_token}` },
          })
        ).status,
      ).toBe(401);
      const renewed = await token({
        grant_type: "refresh_token",
        client_id: flow.client.client_id,
        refresh_token: current.refresh_token,
        scope: "scry:testing",
        resource: `${base}/mcp`,
      });
      const result = await renewed.json();
      expect(renewed.status, result.error_description).toBe(200);
      expect(result.scope).toBe("scry:testing");
      expect(
        (
          await fetch(`${base}/api/projects`, {
            headers: { authorization: `Bearer ${result.access_token}` },
          })
        ).status,
      ).toBe(200);
      current = result;
    }
    expect(
      (
        await database.query(
          "SELECT id FROM oauth_connections WHERE client_id=$1 AND revoked_at IS NULL",
          [flow.client.client_id],
        )
      ).rowCount,
    ).toBe(1);
  }, 20000);
  it("recovers old session-bound testing tokens without reviving expired or revoked credentials", async () => {
    const flow = await begin("scry:testing");
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const Adapter = providerAdapter(database);
    const refreshes = new Adapter("RefreshToken");
    const accesses = new Adapter("AccessToken");
    const refresh = (await refreshes.find(issued.refresh_token))!;
    const access = (await accesses.find(issued.access_token))!;
    // Emulate persisted tokens issued by the preceding release. All fixture
    // credentials remain encrypted; this does not modify a real connection.
    await refreshes.upsert(
      issued.refresh_token,
      { ...refresh, expiresWithSession: true },
      30 * 86400,
    );
    await accesses.upsert(issued.access_token, { ...access, expiresWithSession: true }, 300);
    await database.query(
      "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='Session' AND uid_hash=$1",
      [createHash("sha256").update(String(refresh.sessionUid)).digest("hex")],
    );
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(200);
    const renewed = await token({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: issued.refresh_token,
      scope: "scry:testing",
      resource: `${base}/mcp`,
    });
    const result = await renewed.json();
    expect(renewed.status, result.error_description).toBe(200);
    await database.query(
      "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='AccessToken' AND id_hash=$1",
      [createHash("sha256").update(result.access_token).digest("hex")],
    );
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${result.access_token}` },
        })
      ).status,
    ).toBe(401);
    await app.get(OAuthService).discardGrant(String(refresh.grantId));
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: result.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
  }, 20000);
  it("recovers a lost refresh response using the identical bounded receipt", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = await (await exchange(flow, code)).json();
    const renew = () =>
      token({
        grant_type: "refresh_token",
        client_id: flow.client.client_id,
        refresh_token: issued.refresh_token,
        resource: `${base}/mcp`,
      });
    const first = await renew();
    const replacement = await first.json();
    expect(first.status).toBe(200);
    // A client loses this response and retries the same request.
    const retried = await renew();
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json();
    expect(retriedBody.refresh_token === replacement.refresh_token).toBe(true);
    expect(retriedBody.access_token === replacement.access_token).toBe(true);
    expect(retriedBody.expires_in).toBeGreaterThan(290);
    expect(retriedBody.expires_in).toBeLessThanOrEqual(replacement.expires_in);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const later = await renew();
    expect(later.status).toBe(200);
    const laterBody = await later.json();
    expect(laterBody.expires_in).toBeGreaterThan(0);
    expect(laterBody.expires_in).toBeLessThan(replacement.expires_in);
    expect(laterBody.refresh_token === replacement.refresh_token).toBe(true);
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${replacement.access_token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("gives concurrent refresh consumers one usable successor without family revocation", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = await (await exchange(flow, code)).json();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: issued.refresh_token,
          resource: `${base}/mcp`,
        }),
      ),
    );
    const winners = outcomes.filter((r) => r.status === 200);
    expect(winners.length).toBe(6);
    const bodies = await Promise.all(outcomes.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.refresh_token)).size).toBe(1);
    expect(new Set(bodies.map((b) => b.access_token)).size).toBe(1);
    if (winners.length) {
      const replacement = bodies[0];
      const followup = await token({
        grant_type: "refresh_token",
        client_id: flow.client.client_id,
        refresh_token: replacement.refresh_token,
        resource: `${base}/mcp`,
      });
      expect(followup.status).toBe(200);
    }
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: {
            authorization: `Bearer ${issued.access_token}`,
          },
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a second-oldest refresh token even inside the retry window", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    expect((await s.renew({ refresh_token: a.refresh_token })).status).toBe(200);
    expect((await s.renew()).status).toBe(400);
    expect(await projectStatus(a.access_token)).toBe(401);
    expect(
      (
        await database.query(
          "SELECT outcome FROM oauth_connection_events WHERE connection_id=$1 ORDER BY id DESC LIMIT 1",
          [s.connection.id],
        )
      ).rows[0]!.outcome,
    ).toBe("replay_refused");
  });

  it.each([{ scope: "scry:testing" }, { resource: "https://wrong-resource.example/mcp" }])(
    "never reuses a receipt for altered effective request parameters %j",
    async (patch) => {
      const s = await linked();
      const a = await (await s.renew()).json();
      expect((await s.renew(patch)).status).toBe(400);
      expect(await projectStatus(a.access_token)).toBe(401);
    },
  );

  it("refuses wrong-client replay without revoking the legitimate connection", async () => {
    const s = await linked(),
      other = await linked(false);
    const a = await (await s.renew()).json();
    expect((await s.renew({ client_id: other.flow.client.client_id })).status).toBe(400);
    expect(await projectStatus(a.access_token)).toBe(200);
    expect((await s.renew()).status).toBe(200);
  });

  it("rechecks expiry, disconnect and membership before returning a retry receipt", async () => {
    for (const mode of ["expiry", "disconnect", "membership"]) {
      const s = await linked();
      expect((await s.renew()).status).toBe(200);
      if (mode === "expiry")
        await database.query(
          "UPDATE oauth_provider_records SET expires_at=clock_timestamp()-interval '1 second' WHERE model='Grant' AND id_hash=$1",
          [s.connection.grant_hash],
        );
      if (mode === "disconnect")
        await app
          .get(ConnectionsRepository)
          .revoke(
            { kind: "user", credentialKind: "user", userId: s.connection.user_id } as any,
            s.connection.id,
          );
      if (mode === "membership")
        await database.query(
          "DELETE FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2",
          [s.connection.user_id, s.connection.workspace_id],
        );
      try {
        expect((await s.renew()).status).toBe(400);
      } finally {
        if (mode === "membership")
          await database.query(
            "INSERT INTO workspace_memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",
            [s.connection.user_id, s.connection.workspace_id],
          );
      }
    }
  });

  it("does not extend the fixed retry deadline or expose plaintext provider receipts", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    const read = async () =>
      (
        await database.query(
          "SELECT *,expires_at-created_at AS duration FROM oauth_renewal_receipts WHERE grant_hash=$1",
          [s.connection.grant_hash],
        )
      ).rows[0]!;
    const before = await read();
    for (let i = 0; i < 36; i++) expect((await s.renew()).status).toBe(200);
    const after = await read();
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
    expect(after.duration.seconds).toBe(10);
    const safe = JSON.stringify(after);
    expect(safe.includes(a.access_token)).toBe(false);
    expect(safe.includes(a.refresh_token)).toBe(false);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM oauth_connection_events WHERE connection_id=$1",
          [s.connection.id],
        )
      ).rows[0]!.n,
    ).toBeLessThanOrEqual(32);
    const facts = await app
      .get(ConnectionsRepository)
      .diagnostics(
        { kind: "user", credentialKind: "user", userId: s.connection.user_id } as any,
        s.connection.id,
      );
    expect(facts.connection?.lastRenewalEvent.outcome).toBe("retry_recovered");
    expect(JSON.stringify(facts)).not.toMatch(
      /ciphertext|nonce|authentication_tag|predecessor_hash|successor_hash/,
    );
  });

  it("rolls back token consumption and issuance when receipt persistence fails", async () => {
    const s = await linked();
    const encrypt = BrowserProtectedValueCipher.prototype.encrypt;
    const fail = vi
      .spyOn(BrowserProtectedValueCipher.prototype, "encrypt")
      .mockImplementation(function (this: BrowserProtectedValueCipher, value, context) {
        if (context.purpose === "oauth-renewal")
          throw new Error("fictional receipt storage unavailable");
        return encrypt.call(this, value, context);
      });
    try {
      const result = await s.renew();
      expect(result.status).toBe(400);
      expect((await result.json()).error).toBe("temporarily_unavailable");
    } finally {
      fail.mockRestore();
    }
    expect(
      (
        await database.query(
          "SELECT consumed_at FROM oauth_provider_records WHERE model='RefreshToken' AND id_hash=$1",
          [createHash("sha256").update(s.issued.refresh_token).digest("hex")],
        )
      ).rows[0]!.consumed_at,
    ).toBeNull();
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM oauth_provider_records WHERE grant_hash=$1 AND model='RefreshToken'",
          [s.connection.grant_hash],
        )
      ).rows[0]!.n,
    ).toBe(1);
    expect(await projectStatus(s.issued.access_token)).toBe(200);
    expect((await s.renew()).status).toBe(200);
  });

  it("fails closed on a corrupt receipt without invalidating the current successor", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    await database.query(
      "UPDATE oauth_renewal_receipts SET ciphertext=decode('00','hex') WHERE grant_hash=$1",
      [s.connection.grant_hash],
    );
    const result = await s.renew();
    expect(result.status).toBe(400);
    expect((await result.json()).error).toBe("temporarily_unavailable");
    expect(await projectStatus(a.access_token)).toBe(200);
    expect((await s.renew({ refresh_token: a.refresh_token })).status).toBe(200);
  });

  it("recovers the same receipt after a full provider process restart", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    const process = await renewalProcess();
    try {
      const response = await postRenewal(process.endpoint, s.fields);
      expect(response.status).toBe(200);
      const b = await response.json();
      expect(a.refresh_token === b.refresh_token).toBe(true);
      expect(a.access_token === b.access_token).toBe(true);
    } finally {
      await process.close();
    }
  }, 20000);

  it("serializes renewal across independent provider processes", async () => {
    const s = await linked();
    const first = await renewalProcess(),
      second = await renewalProcess();
    try {
      const responses = await Promise.all(
        Array.from({ length: 18 }, (_, i) =>
          postRenewal([`${base}/oauth/token`, first.endpoint, second.endpoint][i % 3]!, s.fields),
        ),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(new Set(bodies.map((b) => b.refresh_token)).size).toBe(1);
      expect(new Set(bodies.map((b) => b.access_token)).size).toBe(1);
      expect(await projectStatus(bodies[0].access_token)).toBe(200);
      expect(
        (
          await database.query(
            "SELECT count(*)::int AS n FROM oauth_renewal_receipts WHERE grant_hash=$1",
            [s.connection.grant_hash],
          )
        ).rows[0]!.n,
      ).toBe(1);
    } finally {
      await first.close();
      await second.close();
    }
  }, 20000);

  it("survives a killed issuance process without consuming the original credential", async () => {
    const s = await linked();
    const process = await renewalProcess(true);
    try {
      await expect(postRenewal(process.endpoint, s.fields)).rejects.toThrow();
      expect((await s.renew()).status).toBe(200);
      expect(await projectStatus(s.issued.access_token)).toBe(200);
    } finally {
      await process.close();
    }
  }, 20000);

  it("cleans expired receipts without changing live grant authority", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    await database.query(
      "UPDATE oauth_renewal_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE grant_hash=$1",
      [s.connection.grant_hash],
    );
    await app.get(OAuthService).sweepExpired();
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM oauth_renewal_receipts WHERE grant_hash=$1",
          [s.connection.grant_hash],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(await projectStatus(a.access_token)).toBe(200);
    expect((await s.renew({ refresh_token: a.refresh_token })).status).toBe(200);
  });

  it("authenticates confidential clients again before returning a receipt", async () => {
    const flow = await begin("scry:testing", "client_secret_post");
    const { code } = await approve(flow);
    const exchangeResponse = await exchange(flow, code);
    expect(exchangeResponse.status).toBe(200);
    const issued = await exchangeResponse.json();
    const fields = {
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      client_secret: flow.client.client_secret!,
      refresh_token: issued.refresh_token,
      resource: `${base}/mcp`,
    };
    const first = await postRenewal(`${base}/oauth/token`, fields);
    expect(first.status).toBe(200);
    const a = await first.json();
    const refused = await postRenewal(`${base}/oauth/token`, {
      ...fields,
      client_secret: "wrong-fictional-client-secret",
    });
    expect([400, 401]).toContain(refused.status);
    expect((await refused.json()).error).toBe("invalid_client");
    const retry = await postRenewal(`${base}/oauth/token`, fields);
    expect(retry.status).toBe(200);
    expect((await retry.json()).refresh_token === a.refresh_token).toBe(true);
    expect(await projectStatus(a.access_token)).toBe(200);
  });

  it("rejects malformed duplicate parameters before receipt recovery", async () => {
    const s = await linked();
    expect((await s.renew()).status).toBe(200);
    const body = new URLSearchParams(s.fields);
    body.append("client_id", s.fields.client_id);
    const result = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toBe("invalid_request");
    expect((await s.renew()).status).toBe(200);
  });

  it("recovers a lost commit acknowledgement without issuing a competing successor", async () => {
    const s = await linked();
    const original = database.boundedTransaction.bind(database);
    let lost = false;
    const fail = vi.spyOn(database, "boundedTransaction").mockImplementation(async (work) => {
      const result = await original(work);
      if (!lost) {
        lost = true;
        throw new Error("fictional lost commit acknowledgement");
      }
      return result;
    });
    try {
      const result = await s.renew();
      expect(result.status).toBe(400);
      expect((await result.json()).error).toBe("temporarily_unavailable");
    } finally {
      fail.mockRestore();
    }
    const retry = await s.renew();
    expect(retry.status).toBe(200);
    const a = await retry.json();
    const repeated = await s.renew();
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).refresh_token === a.refresh_token).toBe(true);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM oauth_provider_records WHERE grant_hash=$1 AND model='RefreshToken'",
          [s.connection.grant_hash],
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it("bounds lock contention without blocking other grants or consuming a credential", async () => {
    const blocked = await linked(),
      independent = await linked(),
      holder = await database.pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,731927))", [
      blocked.connection.grant_hash,
    ]);
    try {
      const waiting = blocked.renew();
      expect((await independent.renew()).status).toBe(200);
      const result = await waiting;
      expect(result.status).toBe(400);
      expect((await result.json()).error).toBe("temporarily_unavailable");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await blocked.renew()).status).toBe(200);
  }, 15000);

  it("does not resurrect credentials when disconnect races renewal", async () => {
    const s = await linked();
    expect((await s.renew()).status).toBe(200);
    const outcomes = await Promise.all([
      ...Array.from({ length: 8 }, () => s.renew()),
      app
        .get(ConnectionsRepository)
        .revoke(
          { kind: "user", credentialKind: "user", userId: s.connection.user_id } as any,
          s.connection.id,
        ),
    ]);
    for (const response of outcomes.slice(0, -1) as Response[]) {
      expect([200, 400]).toContain(response.status);
      const body = await response.json();
      if (body.access_token) expect(await projectStatus(body.access_token)).toBe(401);
    }
    expect((await s.renew()).status).toBe(400);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM oauth_renewal_receipts WHERE grant_hash=$1",
          [s.connection.grant_hash],
        )
      ).rows[0]!.n,
    ).toBe(0);
  });

  it("recovers after the actual HTTP response socket is lost following commit", async () => {
    const s = await linked(),
      process = await renewalProcess("after_commit_drop");
    try {
      await expect(postRenewal(process.endpoint, s.fields)).rejects.toThrow();
      const retry = await s.renew();
      expect(retry.status).toBe(200);
      const a = await retry.json();
      expect(await projectStatus(a.access_token)).toBe(200);
      expect(
        (
          await database.query(
            "SELECT count(*)::int AS n FROM oauth_provider_records WHERE grant_hash=$1 AND model='RefreshToken'",
            [s.connection.grant_hash],
          )
        ).rows[0]!.n,
      ).toBe(2);
    } finally {
      await process.close();
    }
  }, 20000);

  it("enforces the actual ten-second wall-clock retry limit", async () => {
    const s = await linked();
    const a = await (await s.renew()).json();
    await new Promise((resolve) => setTimeout(resolve, 10_050));
    expect((await s.renew()).status).toBe(400);
    expect(await projectStatus(a.access_token)).toBe(401);
  }, 15000);

  it("characterizes access-token revocation independently from refresh-token revocation", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = await (await exchange(flow, code)).json();
    const revoked = await fetch(`${base}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: flow.client.client_id,
        token: issued.access_token,
        token_type_hint: "access_token",
      }),
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: issued.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
  });

  it("revokes a rotated refresh-token family on reuse and gives a new connection independent access", async () => {
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const first = await token({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: issued.refresh_token,
      resource: `${base}/mcp`,
    });
    const rotated = (await first.json()) as typeof issued;
    expect(first.status).toBe(200);
    await database.query(
      "UPDATE oauth_renewal_receipts SET expires_at=created_at-interval '1 second' WHERE predecessor_hash=$1",
      [createHash("sha256").update(issued.refresh_token).digest("hex")],
    );
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: issued.refresh_token,
          resource: `${base}/mcp`,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${rotated.access_token}` },
        })
      ).status,
    ).toBe(401);
    const next = await begin();
    const replacement = await approve(next);
    const linked = (await (await exchange(next, replacement.code)).json()) as typeof issued;
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${linked.access_token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/projects`, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        })
      ).status,
    ).toBe(401);
  }, 20000);
  it("invalidates the new grant when the browser handoff fails after approval", async () => {
    const flow = await begin();
    const fail = vi
      .spyOn(app.get(OAuthService).provider!, "interactionResult")
      .mockRejectedValueOnce(new Error("fictional interrupted handoff"));
    try {
      expect((await approve(flow)).response.status).toBe(500);
    } finally {
      fail.mockRestore();
    }
    const rows = await database.query(
      "SELECT grant_hash,revoked_at FROM oauth_connections WHERE client_id=$1",
      [flow.client.client_id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.revoked_at).toBeTruthy();
    expect(
      (
        await database.query("SELECT id_hash FROM oauth_provider_records WHERE grant_hash=$1", [
          rows.rows[0]!.grant_hash,
        ])
      ).rowCount,
    ).toBe(0);
  }, 20000);
});
