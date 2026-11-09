import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
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

  async function begin(scope = "scry:testing offline_access") {
    const registered = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Fictional test assistant",
        redirect_uris: ["http://127.0.0.1:49199/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        // Standard MCP SDK clients include the discovered/requested scope in DCR.
        scope: "scry:testing offline_access",
      }),
    });
    const client = (await registered.json()) as { client_id: string };
    expect(registered.status, JSON.stringify(client)).toBe(201);
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
    return { client, verifier, uid, browser };
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
    const flow = await begin();
    const { code } = await approve(flow);
    const issued = (await (await exchange(flow, code)).json()) as {
      access_token: string;
      refresh_token: string;
    };
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
