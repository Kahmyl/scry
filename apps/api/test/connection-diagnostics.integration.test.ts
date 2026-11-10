import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { ConnectionsRepository } from "../src/auth/oauth/connections.repository.js";
import { providerAdapter, digest } from "../src/auth/oauth/provider-adapter.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { seedSession } from "./fixtures/browser-session.js";
import type { UserPrincipal } from "../src/auth/auth.types.js";
const url = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  "connection diagnostics distinguish server facts from host discovery",
  () => {
    let db: Database, connections: ConnectionsRepository;
    beforeAll(() => {
      process.env.DATABASE_URL = url;
      process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
      db = new Database();
      connections = new ConnectionsRepository(db);
    });
    afterAll(() => db?.onModuleDestroy());
    async function setup() {
      const sid = await seedSession(
        db,
        new BrowserExecutionRepository(db, new BrowserProtectedValueCipher()),
        "https://connection.fixture.test",
      );
      const s = (
        await db.query<any>(
          `SELECT u.id AS "userId",u.email,u.supabase_user_id AS subject,p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id JOIN workspace_memberships m ON m.workspace_id=p.workspace_id JOIN app_users u ON u.id=m.user_id WHERE s.id=$1`,
          [sid],
        )
      ).rows[0]!;
      const owner: UserPrincipal = { ...s, kind: "user", credentialKind: "user", role: "owner" },
        clientId = randomUUID(),
        grantId = randomUUID(),
        Adapter = providerAdapter(db);
      await new Adapter("Client").upsert(clientId, { client_id: clientId }, 3600);
      const id = await connections.approve(owner, {
        workspaceId: s.workspaceId,
        clientId,
        clientName: "Codex",
        grantId,
      });
      await new Adapter("Grant").upsert(grantId, { accountId: owner.userId, clientId }, 3600);
      return { owner, id, clientId, grantId };
    }
    it("shows valid independent facts without claiming host exposure or returning provider secrets", async () => {
      const s = await setup(),
        r = await connections.diagnostics(s.owner, s.id);
      expect(r).toMatchObject({
        serverAuthenticated: true,
        hostToolExposure: "unknown",
        connection: {
          revoked: false,
          workspaceAccess: true,
          grantAvailable: true,
          clientRegistrationAvailable: true,
        },
      });
      expect(JSON.stringify(r)).not.toMatch(
        /ciphertext|nonce|authentication_tag|grant_hash|id_hash/,
      );
    });
    it("distinguishes grant expiry from a retained client registration", async () => {
      const s = await setup();
      await db.query(
        "UPDATE oauth_provider_records SET expires_at=now()-interval '1 second' WHERE model='Grant' AND id_hash=$1",
        [digest(s.grantId)],
      );
      expect((await connections.diagnostics(s.owner, s.id)).connection).toMatchObject({
        grantAvailable: false,
        clientRegistrationAvailable: true,
      });
    });
    it("distinguishes missing/expired registration from a retained grant", async () => {
      const s = await setup();
      await db.query("DELETE FROM oauth_provider_records WHERE model='Client' AND id_hash=$1", [
        digest(s.clientId),
      ]);
      expect((await connections.diagnostics(s.owner, s.id)).connection).toMatchObject({
        grantAvailable: true,
        clientRegistrationAvailable: false,
      });
    });
    it("workspace removal remains visible on the independent dashboard path", async () => {
      const s = await setup();
      await db.query("DELETE FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2", [
        s.owner.userId,
        s.owner.workspaceId,
      ]);
      expect((await connections.diagnostics(s.owner, s.id)).connection).toMatchObject({
        workspaceAccess: false,
      });
    });
    it("shows explicit revocation and does not make historical use authoritative", async () => {
      const s = await setup();
      await db.query("UPDATE oauth_connections SET last_used_at=now() WHERE id=$1", [s.id]);
      await connections.revoke(s.owner, s.id);
      const r = await connections.diagnostics(s.owner, s.id);
      expect(r.connection).toMatchObject({ revoked: true, grantAvailable: false });
      expect(r.hostToolExposure).toBe("unknown");
    });
    it("never reveals another customer's grant or lets an MCP token choose a management ID", async () => {
      const s = await setup(),
        other = await setup();
      await expect(connections.diagnostics(other.owner, s.id)).rejects.toThrow(
        "Connection not found",
      );
      await expect(
        connections.diagnostics(
          { ...s.owner, credentialKind: "mcp", oauthConnectionId: s.id },
          s.id,
        ),
      ).rejects.toThrow("Sign in to Scry");
      expect(
        (
          await connections.diagnostics({
            ...s.owner,
            credentialKind: "mcp",
            oauthConnectionId: s.id,
          })
        ).connection,
      ).toMatchObject({ id: s.id });
    });
    it("service diagnostics do not enumerate customer authorizations", async () => {
      expect(
        await connections.diagnostics({ kind: "service", subject: "scry-service" }),
      ).toMatchObject({ serverAuthenticated: true, connection: null, hostToolExposure: "unknown" });
    });
  },
);
