import "reflect-metadata";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { MediaPlaybackController } from "../src/auth/media-playback.controller.js";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { AuthService } from "../src/auth/auth.service.js";
import { IdentityRepository } from "../src/auth/repositories/identity.repository.js";
import { McpTokenRepository } from "../src/auth/repositories/mcp-token.repository.js";
import { BrowserDashboardRepository } from "../src/browser-execution/repositories/browser-dashboard.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { seedSession } from "./fixtures/browser-session.js";
import type { UserPrincipal } from "../src/auth/auth.types.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(url ? describe : describe.skip)("scoped authenticated native playback", () => {
  let db: Database,
    app: NestFastifyApplication,
    root: string,
    runId: string,
    workspaceId: string,
    owner: UserPrincipal,
    token: { token: string; id: string },
    bytes: Buffer,
    receipt: any,
    available = true;
  const headers = () => ({ authorization: `Bearer ${token.token}` });
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    db = new Database();
    const sessionId = await seedSession(
      db,
      new BrowserExecutionRepository(db, new BrowserProtectedValueCipher()),
      "https://playback.fixture.test",
    );
    const s = (
      await db.query<any>(
        'SELECT s.run_id AS "runId",p.workspace_id AS "workspaceId",u.id AS "userId",u.email,u.supabase_user_id AS subject FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id JOIN workspace_memberships m ON m.workspace_id=p.workspace_id JOIN app_users u ON u.id=m.user_id WHERE s.id=$1',
        [sessionId],
      )
    ).rows[0]!;
    runId = s.runId;
    workspaceId = s.workspaceId;
    owner = {
      kind: "user",
      credentialKind: "user",
      subject: s.subject,
      userId: s.userId,
      workspaceId,
      role: "owner",
      email: s.email,
    };
    token = (await new McpTokenRepository(db).create(owner, "Fixture playback")) as any;
    root = await mkdtemp(path.join(tmpdir(), "scry-playback-"));
    const key = `native/1/${randomUUID()}/${randomUUID()}.mp4`;
    await mkdir(path.dirname(path.join(root, key)), { recursive: true });
    bytes = Buffer.from("fictional-recording-data-".repeat(10000));
    await writeFile(path.join(root, key), bytes, { mode: 0o600 });
    receipt = {
      kind: "video",
      objectKey: key,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      timestamp: Date.now(),
      label: "final",
    };
    @Module({
      controllers: [MediaPlaybackController],
      providers: [
        { provide: Database, useValue: db },
        {
          provide: BrowserDashboardRepository,
          useValue: {
            mediaForStreaming: async (scope: string | undefined, id: string, index: number) => {
              if (!available || scope !== workspaceId || id !== runId || index !== 0)
                throw Error("Unavailable scoped evidence");
              return { root, receipt, type: "video/mp4" };
            },
          },
        },
        IdentityRepository,
        AuthService,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    })
    class Fixture {}
    app = await NestFactory.create<NestFastifyApplication>(Fixture, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    if (app) await app.close();
    else await db?.onModuleDestroy();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function mint() {
    const r = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/media/0/playback`,
      headers: headers(),
    });
    expect(r.statusCode).toBe(201);
    const grant = r.json(),
      cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    return { grant, cookie };
  }
  async function read(grant: any, cookie: string, range?: string) {
    return app.inject({
      method: "GET",
      url: "/api" + grant.path,
      headers: { cookie, ...(range ? { range } : {}) },
    });
  }
  it("requires bearer authorization to mint and a separate scoped cookie to read", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/runs/${runId}/media/0/playback` })).statusCode,
    ).toBe(401);
    const { grant, cookie } = await mint();
    expect(JSON.stringify(grant)).not.toContain(token.token);
    expect(grant.path).not.toMatch(/secret|token|\?/);
    expect((await app.inject({ method: "GET", url: "/api" + grant.path })).statusCode).toBe(401);
    expect((await read(grant, cookie)).rawPayload).toEqual(bytes);
  });
  it.each(["bytes=0-31", "bytes=99-", "bytes=-50"])(
    "serves exact byte range %s with private headers",
    async (range) => {
      const { grant, cookie } = await mint(),
        r = await read(grant, cookie, range);
      expect(r.statusCode).toBe(206);
      expect(r.headers["accept-ranges"]).toBe("bytes");
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      const m = String(r.headers["content-range"]).match(/bytes (\d+)-(\d+)\/(\d+)/)!;
      expect(r.rawPayload).toEqual(bytes.subarray(Number(m[1]), Number(m[2]) + 1));
    },
  );
  it("rejects invalid/multiple ranges and supports a bodyless authenticated HEAD", async () => {
    const { grant, cookie } = await mint();
    expect((await read(grant, cookie, "bytes=0-1,5-6")).statusCode).toBe(416);
    expect((await read(grant, cookie, "bytes=99999999-")).headers["content-range"]).toBe(
      `bytes */${bytes.length}`,
    );
    const r = await app.inject({ method: "HEAD", url: "/api" + grant.path, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(0);
    expect(r.headers["content-length"]).toBe(String(bytes.length));
  });
  it("a mismatched If-Range returns a full verified representation", async () => {
    const { grant, cookie } = await mint();
    const r = await app.inject({
      method: "GET",
      url: "/api" + grant.path,
      headers: { cookie, range: "bytes=0-4", "if-range": '"old"' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(bytes);
  });
  it("cookie from another grant cannot authorize this URL", async () => {
    const first = await mint(),
      second = await mint();
    expect((await read(second.grant, first.cookie)).statusCode).toBe(401);
    expect((await read(first.grant, second.cookie)).statusCode).toBe(401);
  });
  it("expired and explicitly revoked playback cannot be replayed", async () => {
    const a = await mint();
    await db.query(
      "UPDATE media_playback_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
      [a.grant.id],
    );
    expect((await read(a.grant, a.cookie)).statusCode).toBe(401);
    const b = await mint();
    await app.inject({ method: "DELETE", url: "/api" + b.grant.path, headers: headers() });
    expect((await read(b.grant, b.cookie)).statusCode).toBe(401);
  });
  it("renewal requires both account authentication and the exact scoped cookie", async () => {
    const { grant, cookie } = await mint(),
      endpoint = "/api" + grant.path + "/renew";
    expect(
      (await app.inject({ method: "POST", url: endpoint, headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: endpoint, headers: headers() })).statusCode,
    ).toBe(403);
    const r = await app.inject({
      method: "POST",
      url: endpoint,
      headers: { ...headers(), cookie },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().path).toBe(grant.path);
    expect(String(r.headers["set-cookie"])).toContain("HttpOnly; SameSite=Strict");
  });
  it("an expired playback lease does not report an account authentication failure", async () => {
    const { grant, cookie } = await mint();
    await db.query(
      "UPDATE media_playback_grants SET expires_at=now()-interval '1 second' WHERE id=$1",
      [grant.id],
    );
    const r = await app.inject({
      method: "POST",
      url: "/api" + grant.path + "/renew",
      headers: { ...headers(), cookie },
    });
    expect(r.statusCode).toBe(403);
    const fresh = await mint();
    expect((await read(fresh.grant, fresh.cookie, "bytes=0-31")).statusCode).toBe(206);
  });
  it("read-only workspace viewers retain authenticated recording access", async () => {
    await db.query(
      "UPDATE workspace_memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
      [workspaceId, owner.userId],
    );
    try {
      const { grant, cookie } = await mint();
      expect((await read(grant, cookie, "bytes=0-31")).statusCode).toBe(206);
    } finally {
      await db.query(
        "UPDATE workspace_memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
        [workspaceId, owner.userId],
      );
    }
  });
  it("workspace removal and source-token revocation invalidate later ranges", async () => {
    const a = await mint();
    await db.query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2", [
      workspaceId,
      owner.userId,
    ]);
    expect((await read(a.grant, a.cookie)).statusCode).toBe(401);
    await db.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, owner.userId],
    );
    const b = await mint();
    await db.query("UPDATE mcp_access_tokens SET revoked_at=now() WHERE id=$1", [token.id]);
    expect((await read(b.grant, b.cookie)).statusCode).toBe(401);
    token = (await new McpTokenRepository(db).create(owner, "Replacement fixture")) as any;
  });
  it("checks retention/visibility again and never substitutes a different admitted artifact", async () => {
    const a = await mint();
    available = false;
    expect((await read(a.grant, a.cookie)).statusCode).not.toBe(200);
    available = true;
    const digest = receipt.digest;
    receipt.digest = "f".repeat(64);
    expect((await read(a.grant, a.cookie)).statusCode).toBe(404);
    receipt.digest = digest;
  });
  it("tampered file bytes are refused before delivery and scratch copies disappear", async () => {
    const a = await mint();
    await writeFile(path.join(root, receipt.objectKey), Buffer.alloc(bytes.length, 88));
    expect((await read(a.grant, a.cookie)).statusCode).not.toBe(200);
    await writeFile(path.join(root, receipt.objectKey), bytes);
    for (let i = 0; i < 50 && (await readdir(path.join(root, "read-staging"))).length; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await readdir(path.join(root, "read-staging"))).toEqual([]);
  });
  it("playback capacity returns waiting rather than signing the account out", async () => {
    await db.query("UPDATE media_playback_grants SET revoked_at=now() WHERE user_id=$1", [
      owner.userId,
    ]);
    for (let i = 0; i < 20; i++) await mint();
    const r = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/media/0/playback`,
      headers: headers(),
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("120");
    await db.query("UPDATE media_playback_grants SET revoked_at=now() WHERE user_id=$1", [
      owner.userId,
    ]);
    expect((await mint()).grant.id).toBeTruthy();
  });
});
