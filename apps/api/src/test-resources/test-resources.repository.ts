import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { CreateTestResourceInput, TestEvent, TestResource } from "@scry/contracts";
import { protectTestMessage } from "@scry/veil";
import { Database } from "../infrastructure/database.js";
import {
  BrowserProtectedValueCipher,
  type EncryptedProtectedValue,
} from "../browser-execution/protected-value-cipher.js";
import { resourceError, providerDatabaseBudget, ProviderDeferred } from "./provider-http.js";
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
const messageProtectionVersion = 1;
type EventRow = TestEvent & { recordedAt: string; protectionVersion: number };

function protectedMessage(title: string, content: unknown) {
  const result = protectTestMessage({ title, content });
  return {
    candidates: result.candidates,
    data:
      typeof result.safe === "string"
        ? { title: "Message withheld", content: result.safe }
        : (result.safe as { title: string; content: unknown }),
  };
}

@Injectable()
export class TestResourcesRepository {
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(BrowserProtectedValueCipher) readonly cipher: BrowserProtectedValueCipher,
  ) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.boundedTransaction(work, providerDatabaseBudget());
    } catch (error) {
      const code = (error as { code?: string }).code,
        message = error instanceof Error ? error.message : "";
      if (
        ["55P03", "57014"].includes(code ?? "") ||
        /TRANSACTION_DEADLINE|Query read timeout|timeout exceeded when trying to connect/i.test(
          message,
        )
      )
        throw new ProviderDeferred(2, "unavailable");
      throw error;
    }
  }
  private query<T extends QueryResultRow = any>(sql: string, values: unknown[] = []) {
    return this.transaction((c) => c.query<T>(sql, values));
  }
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
    const result = await this.query<{ projectId: string }>(
      `SELECT m.project_id AS "projectId" FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [missionId, workspaceId ?? null],
    );
    if (!result.rowCount) resourceError("TEST_MISSION_NOT_FOUND", 404);
    return result.rows[0]!;
  }
  async resource(workspaceId: string | undefined, id: string) {
    const result = await this.query<ResourceRow>(
      `SELECT ${projection} FROM test_resources t JOIN missions m ON m.id=t.mission_id JOIN projects p ON p.id=m.project_id WHERE t.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [id, workspaceId ?? null],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_NOT_FOUND", 404);
    return result.rows[0]!;
  }
  async list(workspaceId: string | undefined, missionId: string) {
    await this.requireMission(workspaceId, missionId);
    const rows = await this.query<ResourceRow>(
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
    const id = await this.transaction(async (c) => {
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
    const result = await this.query(
      `UPDATE test_resources SET lease_id=$2,lease_until=now()+interval '120 seconds' ${closing ? ",state='closing'" : ""} WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) AND state=$3 AND state ${closing ? "IN ('pending','ready','closing')" : "IN ('pending','ready')"} RETURNING id`,
      [row.id, leaseId, row.state],
    );
    return result.rowCount ? leaseId : undefined;
  }
  async mailboxPassword(projectId: string, id: string): Promise<string> {
    const result = await this.query(
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
    const result = await this.query(
      "UPDATE test_resources SET private_data=$3::jsonb WHERE id=$1 AND lease_id=$2 AND lease_until>now()",
      [id, lease, JSON.stringify(this.seal(state, id))],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
  }
  async ready(id: string, lease: string, address: string, privateData: PrivateResource) {
    const result = await this.query(
      `UPDATE test_resources SET state='ready',address=$3,private_data=$4::jsonb WHERE id=$1 AND lease_id=$2 AND lease_until>now() AND state='pending'`,
      [id, lease, address, JSON.stringify(this.seal(privateData, id))],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
  }
  async release(id: string, lease: string) {
    await this.db.boundedTransaction(
      (c) =>
        c.query(
          "UPDATE test_resources SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",
          [id, lease],
        ),
      1000,
    );
  }
  async markClosed(id: string, lease: string) {
    const result = await this.query(
      "UPDATE test_resources SET state='closed',address=NULL WHERE id=$1 AND lease_id=$2 AND lease_until>now() RETURNING id",
      [id, lease],
    );
    if (!result.rowCount) resourceError("TEST_RESOURCE_BUSY", 409);
  }
  async expiredForCleanup() {
    return (
      await this.query<{ id: string }>(
        "SELECT id FROM test_resources WHERE expires_at<now() AND state<>'closed' AND (lease_until IS NULL OR lease_until<now()) ORDER BY expires_at LIMIT 10",
      )
    ).rows;
  }
  async known(id: string) {
    return new Set(
      (
        await this.query<{ provider_event_id: string }>(
          "SELECT provider_event_id FROM test_resource_events WHERE resource_id=$1",
          [id],
        )
      ).rows.map((r) => r.provider_event_id),
    );
  }

  async record(row: ResourceRow, lease: string, messages: ReceivedTestMessage[]) {
    await this.transaction(async (c) => {
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
        const { data, candidates } = protectedMessage(message.title, message.content);
        const refs = await this.writeSecrets(c, row.projectId, row.missionId, id, candidates);
        await c.query(
          `INSERT INTO test_resource_events(id,resource_id,provider_event_id,received_at,title,safe_content,protected_refs,protection_version) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
          [
            id,
            row.id,
            message.id,
            message.receivedAt,
            data.title,
            JSON.stringify(data.content),
            JSON.stringify(refs),
            messageProtectionVersion,
          ],
        );
      }
    });
  }
  private async writeSecrets(
    c: PoolClient,
    projectId: string,
    missionId: string,
    eventId: string,
    candidates: Array<{
      kind: "link" | "code";
      value: string;
      source?: TestEvent["secrets"][number]["source"];
      label?: string;
    }>,
    capturedAt?: string,
  ): Promise<TestEvent["secrets"]> {
    if (!candidates.length) return [];
    const refs: TestEvent["secrets"] = [];
    const values: unknown[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const tuples = candidates.map((candidate) => {
      const id = randomUUID(),
        name = `Test ${candidate.kind} ${eventId}`;
      const encrypted = this.cipher.encrypt(candidate.value, {
        projectId,
        protectedValueId: id,
        canonicalName: name,
        sourceKind: "user_input",
      });
      refs.push({
        kind: candidate.kind,
        protectedValueId: id,
        ...(candidate.source ? { source: candidate.source } : {}),
        ...(candidate.label ? { label: candidate.label } : {}),
      });
      return `(${parameter(id)},${parameter(projectId)},'user_input',${parameter(name)},${parameter(`protected://test/${id}`)},${parameter(encrypted.ciphertext)},${parameter(encrypted.nonce)},${parameter(encrypted.authenticationTag)},${parameter(encrypted.valueDigest)},${parameter(encrypted.keyId)},'active',LEAST(now(),COALESCE(${parameter(capturedAt ?? null)}::timestamptz,now()))+interval '1 day',${parameter(`test-${id}`)},${parameter(missionId)})`;
    });
    // At most twenty values per event. One insert avoids a query round trip for
    // every claim while retaining one atomic observation/ref transaction.
    await c.query(
      `INSERT INTO protected_values(id,project_id,source_kind,display_name,external_reference,ciphertext,nonce,authentication_tag,value_digest,key_id,state,expires_at,idempotency_key,mission_id) VALUES ${tuples.join(",")}`,
      values,
    );
    return refs;
  }
  async events(workspaceId: string | undefined, id: string): Promise<TestEvent[]> {
    const resource = await this.resource(workspaceId, id);
    const select = `SELECT id,resource_id AS "resourceId",received_at AS "receivedAt",title,safe_content AS content,protected_refs AS secrets,recorded_at::text AS "recordedAt",protection_version AS "protectionVersion" FROM test_resource_events`;
    // Normal reads do not lock or rewrite already-protected observations.
    const rows = (
      await this.query<EventRow>(`${select} WHERE resource_id=$1 ORDER BY recorded_at,id`, [id])
    ).rows;
    if (rows.some((row) => row.protectionVersion < messageProtectionVersion))
      return this.transaction(async (c) => {
        // Re-read under a stable ordered lock: concurrent dashboard/MCP reads
        // must observe one committed reference set, even after a lost response.
        const locked = await c.query<EventRow>(
          `${select} WHERE resource_id=$1 ORDER BY recorded_at,id FOR UPDATE`,
          [id],
        );
        for (const event of locked.rows) {
          if (event.protectionVersion >= messageProtectionVersion) continue;
          const { data, candidates } = protectedMessage(event.title, event.content);
          const refs = [...event.secrets];
          const existing = refs.length
            ? await c.query<{ value_digest: string }>(
                "SELECT value_digest FROM protected_values WHERE id=ANY($1::uuid[]) AND project_id=$2 AND mission_id=$3",
                [refs.map((ref) => ref.protectedValueId), resource.projectId, resource.missionId],
              )
            : undefined;
          const known = new Set(existing?.rows.map((value) => value.value_digest));
          // Even a leaked legacy alias of an already-issued claim must not
          // mint a new credential or undo its revocation/expiry.
          const fresh = candidates
            .filter(
              (candidate) => !known.has(createHash("sha256").update(candidate.value).digest("hex")),
            )
            .slice(0, Math.max(0, 20 - refs.length));
          refs.push(
            ...(await this.writeSecrets(
              c,
              resource.projectId,
              resource.missionId,
              event.id,
              fresh,
              event.recordedAt,
            )),
          );
          await c.query(
            "UPDATE test_resource_events SET title=$2,safe_content=$3::jsonb,protected_refs=$4::jsonb,protection_version=$5 WHERE id=$1",
            [
              event.id,
              data.title,
              JSON.stringify(data.content),
              JSON.stringify(refs),
              messageProtectionVersion,
            ],
          );
          Object.assign(event, data, { secrets: refs });
        }
        return locked.rows.map((event) => this.publicEvent(event));
      });
    return rows.map((event) => this.publicEvent(event));
  }
  private publicEvent(event: EventRow): TestEvent {
    return {
      id: event.id,
      resourceId: event.resourceId,
      receivedAt: event.receivedAt,
      title: event.title,
      content: event.content,
      secrets: event.secrets.map((ref, index) => ({
        ...ref,
        source: ref.source ?? "earlier_capture",
        label: ref.label ?? `Protected ${ref.kind} ${index + 1}`,
      })),
    };
  }
  async authorizeSecret(
    workspaceId: string | undefined,
    resourceId: string,
    runId: string,
    valueId: string,
  ) {
    const resource = await this.resource(workspaceId, resourceId);
    const result = await this.query(
      `SELECT r.id FROM runs r JOIN test_resource_events e ON e.resource_id=$1 WHERE r.id=$2 AND r.mission_id=$3 AND e.protected_refs @> $4::jsonb LIMIT 1`,
      [resourceId, runId, resource.missionId, JSON.stringify([{ protectedValueId: valueId }])],
    );
    if (!result.rowCount) resourceError("TEST_SECRET_SCOPE_INVALID", 403);
  }
  async signatureContext(
    workspace: string | undefined,
    resourceId: string,
    eventId: string,
    runId: string,
  ) {
    const row = await this.resource(workspace, resourceId);
    if (row.kind !== "webhook") resourceError("TEST_SIGNATURE_WEBHOOK_REQUIRED", 400);
    const event = (
      await this.query(
        "SELECT e.provider_event_id,s.id AS session_id FROM test_resource_events e JOIN runs r ON r.mission_id=$3 JOIN browser_execution_sessions s ON s.run_id=r.id WHERE e.id=$1 AND e.resource_id=$2 AND r.id=$4 AND r.state='running' AND s.state='active'",
        [eventId, resourceId, row.missionId, runId],
      )
    ).rows[0];
    if (!event) resourceError("TEST_SECRET_SCOPE_INVALID", 403);
    return { row, event };
  }
  async signatureReceipt(runId: string, key: string, inputDigest: string) {
    const row = (
      await this.query(
        "SELECT input_digest,safe_receipt FROM test_signature_verifications WHERE run_id=$1 AND idempotency_key=$2",
        [runId, key],
      )
    ).rows[0];
    if (row && row.input_digest !== inputDigest)
      resourceError("TEST_RESOURCE_IDEMPOTENCY_CONFLICT", 409);
    return row?.safe_receipt;
  }
  async saveSignatureReceipt(
    eventId: string,
    runId: string,
    valueId: string,
    key: string,
    inputDigest: string,
    receipt: unknown,
  ) {
    await this.query(
      "INSERT INTO test_signature_verifications(id,event_id,run_id,protected_value_id,idempotency_key,input_digest,safe_receipt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(run_id,idempotency_key) DO NOTHING",
      [randomUUID(), eventId, runId, valueId, key, inputDigest, JSON.stringify(receipt)],
    );
    return this.signatureReceipt(runId, key, inputDigest);
  }
}
