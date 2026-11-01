import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CreateTestResourceInput, TestEvent, TestResource } from "@scry/contracts";
import { protectTestMessage } from "@scry/veil";
import { Database } from "../infrastructure/database.js";
import {
  BrowserProtectedValueCipher,
  type EncryptedProtectedValue,
} from "../browser-execution/protected-value-cipher.js";
import { resourceError } from "./provider-http.js";
import type { PrivateResource, ReceivedTestMessage } from "./providers.js";

type Sealed = { [K in keyof EncryptedProtectedValue]: string };
export type ResourceRow = TestResource & {
  private_data: Sealed;
  lease_id: string | null;
  projectId: string;
  provider: "mail_tm" | "hookdeck";
  connected_address: string | null;
  password_credential_id: string | null;
};
const projection = `t.id,t.mission_id AS "missionId",t.kind,t.name,t.idempotency_key AS "idempotencyKey",t.requested_lifetime AS "expiresInSeconds",t.state,t.address,t.created_at AS "createdAt",t.expires_at AS "expiresAt",
  t.private_data,t.lease_id,t.ownership,t.connected_address,t.password_credential_id,m.project_id AS "projectId"`;

@Injectable()
export class TestResourcesRepository {
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(BrowserProtectedValueCipher) readonly cipher: BrowserProtectedValueCipher,
  ) {}

  seal(value: unknown, id: string): Sealed {
    const encrypted = this.cipher.encrypt(JSON.stringify(value), { testResourceId: id });
    return {
      ciphertext: encrypted.ciphertext.toString("base64"),
      nonce: encrypted.nonce.toString("base64"),
      authenticationTag: encrypted.authenticationTag.toString("base64"),
      valueDigest: encrypted.valueDigest,
      keyId: encrypted.keyId,
    };
  }
  open<T>(data: Sealed, id: string): T {
    return JSON.parse(
      this.cipher.decrypt(
        {
          ...data,
          ciphertext: Buffer.from(data.ciphertext, "base64"),
          nonce: Buffer.from(data.nonce, "base64"),
          authenticationTag: Buffer.from(data.authenticationTag, "base64"),
        },
        { testResourceId: id },
      ),
    );
  }
  public(row: ResourceRow): TestResource {
    return {
      id: row.id,
      missionId: row.missionId,
      kind: row.kind,
      provider: row.kind === "mailbox" ? "mail_tm" : "hookdeck",
      ownership: row.ownership,
      ...(row.ownership === "customer"
        ? {
            connection: {
              address: row.connected_address!,
              passwordCredentialId: row.password_credential_id!,
            },
          }
        : {}),
      name: row.name,
      idempotencyKey: row.idempotencyKey,
      expiresInSeconds: row.expiresInSeconds,
      state: row.state,
      address: row.address,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
  async requireMission(workspaceId: string | undefined, missionId: string) {
    const result = await this.db.query<{ projectId: string }>(
      `SELECT m.project_id AS "projectId" FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [missionId, workspaceId ?? null],
    );
    if (!result.rowCount) resourceError("TEST_MISSION_NOT_FOUND", 404);
    return result.rows[0]!;
  }
  async resource(workspaceId: string | undefined, id: string) {
    const result = await this.db.query<ResourceRow>(
      `SELECT ${projection} FROM test_resources t JOIN missions m ON m.id=t.mission_id JOIN projects p ON p.id=m.project_id WHERE t.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [id, workspaceId ?? null],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_NOT_FOUND", 404);
    return result.rows[0]!;
  }
  async list(workspaceId: string | undefined, missionId: string) {
    await this.requireMission(workspaceId, missionId);
    const rows = await this.db.query<ResourceRow>(
      `SELECT ${projection} FROM test_resources t JOIN missions m ON m.id=t.mission_id WHERE t.mission_id=$1 ORDER BY t.created_at,t.id`,
      [missionId],
    );
    return rows.rows.map((row) => this.public(row));
  }
  async allocate(
    workspaceId: string | undefined,
    missionId: string,
    input: CreateTestResourceInput,
    connection?: { address: string; passwordCredentialId: string },
  ) {
    await this.requireMission(workspaceId, missionId);
    const id = await this.db.transaction(async (c) => {
      // Short allocation lock only; no provider network/file work in this transaction.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [missionId]);
      const prior = await c.query(
        `SELECT id,kind,name,requested_lifetime,ownership,connected_address,password_credential_id FROM test_resources WHERE mission_id=$1 AND idempotency_key=$2`,
        [missionId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (
          prior.rows[0].kind !== input.kind ||
          prior.rows[0].name !== input.name ||
          prior.rows[0].requested_lifetime !== input.expiresInSeconds ||
          prior.rows[0].ownership !== (connection ? "customer" : "scry") ||
          (connection &&
            (prior.rows[0].connected_address !== connection.address ||
              prior.rows[0].password_credential_id !== connection.passwordCredentialId))
        )
          resourceError("TEST_RESOURCE_IDEMPOTENCY_CONFLICT", 409);
        return prior.rows[0].id as string;
      }
      if (connection) {
        const credential = await c.query(
          `SELECT v.id FROM protected_values v JOIN missions m ON m.project_id=v.project_id WHERE m.id=$1 AND v.id=$2 AND v.source_kind='user_input' AND v.mission_id IS NULL AND v.state='active' AND (v.expires_at IS NULL OR v.expires_at>now())`,
          [missionId, connection.passwordCredentialId],
        );
        if (!credential.rowCount) resourceError("TEST_MAIL_CREDENTIAL_UNAVAILABLE", 400);
      }
      const count = await c.query(
        `SELECT count(*) AS n FROM test_resources WHERE mission_id=$1 AND state<>'closed'`,
        [missionId],
      );
      if (Number(count.rows[0].n) >= 20) resourceError("TEST_RESOURCE_CAPACITY", 409);
      const id = randomUUID();
      await c.query(
        `INSERT INTO test_resources(id,mission_id,kind,name,idempotency_key,requested_lifetime,expires_at,private_data,ownership,connected_address,password_credential_id) VALUES($1,$2,$3,$4,$5,$6,now()+($6::int*interval '1 second'),$7::jsonb,$8,$9,$10)`,
        [
          id,
          missionId,
          input.kind,
          input.name,
          input.idempotencyKey,
          input.expiresInSeconds,
          JSON.stringify(
            this.seal(
              connection
                ? { address: connection.address }
                : { password: randomBytes(32).toString("base64url") },
              id,
            ),
          ),
          connection ? "customer" : "scry",
          connection?.address ?? null,
          connection?.passwordCredentialId ?? null,
        ],
      );
      return id;
    });
    return this.resource(workspaceId, id);
  }
  async claim(row: ResourceRow, closing = false) {
    const leaseId = randomUUID();
    const result = await this.db.query(
      `UPDATE test_resources SET lease_id=$2,lease_until=now()+interval '120 seconds' ${closing ? ",state='closing'" : ""} WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) AND state=$3 AND state ${closing ? "IN ('pending','ready','closing')" : "IN ('pending','ready')"} RETURNING id`,
      [row.id, leaseId, row.state],
    );
    return result.rowCount ? leaseId : undefined;
  }
  async mailboxPassword(projectId: string, id: string): Promise<string> {
    const result = await this.db.query(
      `SELECT * FROM protected_values WHERE id=$1 AND project_id=$2 AND source_kind='user_input' AND mission_id IS NULL AND state='active' AND (expires_at IS NULL OR expires_at>now())`,
      [id, projectId],
    );
    const row = result.rows[0];
    if (!row) resourceError("TEST_MAIL_CREDENTIAL_UNAVAILABLE", 400);
    return this.cipher.decrypt(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authenticationTag: row.authentication_tag,
        valueDigest: row.value_digest,
        keyId: row.key_id,
      },
      {
        projectId,
        protectedValueId: id,
        canonicalName: row.display_name,
        sourceKind: "user_input",
      },
    );
  }
  async savePrivate(id: string, lease: string, state: PrivateResource) {
    const result = await this.db.query(
      "UPDATE test_resources SET private_data=$3::jsonb WHERE id=$1 AND lease_id=$2 AND lease_until>now()",
      [id, lease, JSON.stringify(this.seal(state, id))],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
  }
  async ready(id: string, lease: string, address: string, privateData: PrivateResource) {
    const result = await this.db.query(
      `UPDATE test_resources SET state='ready',address=$3,private_data=$4::jsonb WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND state='pending'`,
      [id, lease, address, JSON.stringify(this.seal(privateData, id))],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
  }
  async release(id: string, lease: string) {
    await this.db.query(
      "UPDATE test_resources SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",
      [id, lease],
    );
  }
  async known(id: string) {
    return new Set(
      (
        await this.db.query<{ provider_event_id: string }>(
          "SELECT provider_event_id FROM test_resource_events WHERE resource_id=$1",
          [id],
        )
      ).rows.map((r) => r.provider_event_id),
    );
  }

  async record(row: ResourceRow, lease: string, messages: ReceivedTestMessage[]) {
    await this.db.transaction(async (c) => {
      const owner = await c.query(
        "SELECT id FROM test_resources WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND state='ready' FOR UPDATE",
        [row.id, lease],
      );
      if (!owner.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
      const count = Number(
        (
          await c.query("SELECT count(*) AS n FROM test_resource_events WHERE resource_id=$1", [
            row.id,
          ])
        ).rows[0].n,
      );
      const existing = await c.query<{ provider_event_id: string }>(
        "SELECT provider_event_id FROM test_resource_events WHERE resource_id=$1",
        [row.id],
      );
      const known = new Set(existing.rows.map((message) => message.provider_event_id));
      const fresh = [
        ...new Map(messages.filter((m) => !known.has(m.id)).map((m) => [m.id, m])).values(),
      ];
      if (count + fresh.length > 200) resourceError("TEST_MESSAGE_CAPACITY", 409);
      for (const message of fresh) {
        if (
          typeof message.id !== "string" ||
          !message.id ||
          !Number.isFinite(Date.parse(message.receivedAt))
        )
          resourceError("TEST_PROVIDER_RESPONSE_INVALID");
        if (
          (
            await c.query(
              "SELECT id FROM test_resource_events WHERE resource_id=$1 AND provider_event_id=$2",
              [row.id, message.id],
            )
          ).rowCount
        )
          continue;
        const id = randomUUID();
        const { safe, candidates } = protectTestMessage({
          title: message.title,
          content: message.content,
        });
        const refs: TestEvent["secrets"] = [];
        for (const candidate of candidates) {
          const protectedValueId = randomUUID();
          await this.secret(
            c,
            row.projectId,
            row.missionId,
            protectedValueId,
            `Test ${candidate.kind} ${id}`,
            candidate.kind === "link" ? candidate.value.replaceAll("&amp;", "&") : candidate.value,
          );
          refs.push({ kind: candidate.kind, protectedValueId });
        }
        const data = safe as { title: string; content: unknown };
        await c.query(
          `INSERT INTO test_resource_events(id,resource_id,provider_event_id,received_at,title,safe_content,protected_refs) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
          [
            id,
            row.id,
            message.id,
            message.receivedAt,
            data.title,
            JSON.stringify(data.content),
            JSON.stringify(refs),
          ],
        );
      }
    });
  }
  private async secret(
    c: PoolClient,
    projectId: string,
    missionId: string,
    id: string,
    name: string,
    value: string,
  ) {
    const encrypted = this.cipher.encrypt(value, {
      projectId,
      protectedValueId: id,
      canonicalName: name,
      sourceKind: "user_input",
    });
    await c.query(
      `INSERT INTO protected_values(id,project_id,source_kind,display_name,external_reference,ciphertext,nonce,authentication_tag,value_digest,key_id,state,expires_at,idempotency_key,mission_id) VALUES($1,$2,'user_input',$3,$4,$5,$6,$7,$8,$9,'active',now()+interval '1 day',$10,$11)`,
      [
        id,
        projectId,
        name,
        `protected://test/${id}`,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authenticationTag,
        encrypted.valueDigest,
        encrypted.keyId,
        `test-${id}`,
        missionId,
      ],
    );
  }
  async events(workspaceId: string | undefined, id: string): Promise<TestEvent[]> {
    await this.resource(workspaceId, id);
    return (
      await this.db.query<TestEvent>(
        `SELECT id,resource_id AS "resourceId",received_at AS "receivedAt",title,safe_content AS content,protected_refs AS secrets FROM test_resource_events WHERE resource_id=$1 ORDER BY recorded_at,id`,
        [id],
      )
    ).rows;
  }
  async authorizeSecret(
    workspaceId: string | undefined,
    resourceId: string,
    runId: string,
    valueId: string,
  ) {
    const resource = await this.resource(workspaceId, resourceId);
    const result = await this.db.query(
      `SELECT r.id FROM runs r JOIN test_resource_events e ON e.resource_id=$1 WHERE r.id=$2 AND r.mission_id=$3 AND e.protected_refs @> $4::jsonb LIMIT 1`,
      [resourceId, runId, resource.missionId, JSON.stringify([{ protectedValueId: valueId }])],
    );
    if (!result.rowCount) resourceError("TEST_SECRET_SCOPE_INVALID", 403);
  }
}
