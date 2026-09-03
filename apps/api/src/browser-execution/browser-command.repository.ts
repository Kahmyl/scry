import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import type {
  BrowserCommandV2,
  BrowserDisclosureMode,
  BrowserProtectionSink,
  CreateBrowserProtectedInputV2Input,
  SubmitBrowserCommandV2Input,
} from "@scry/contracts";
import { browserProtectionSinkSchema } from "@scry/contracts";
import type { QueryResultRow } from "pg";
import type { BrowserContextOptions } from "playwright";

import { Database } from "../infrastructure/database.js";
import {
  BrowserProtectedValueCipher,
  type EncryptedProtectedValue,
} from "./protected-value-cipher.js";

interface CommandRow extends QueryResultRow {
  id: string;
  session_id: string;
  run_id: string;
  kind: BrowserCommandV2["kind"];
  safe_input: BrowserCommandV2;
  state: "queued" | "running" | "completed" | "failed";
  safe_result: Record<string, unknown> | null;
  error_code: string | null;
  protected_input_ciphertext: Buffer | null;
  protected_input_nonce: Buffer | null;
  protected_input_authentication_tag: Buffer | null;
  protected_input_digest: string | null;
  protected_input_key_version: string | null;
  claim_token: string | null;
  claim_lease_expires_at: Date | null;
  attempt_count: number;
}

type InlineStorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

@Injectable()
export class BrowserCommandRepository {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(BrowserProtectedValueCipher) private readonly cipher: BrowserProtectedValueCipher,
  ) {}

  async createProtectedInput(
    workspaceId: string | undefined,
    input: CreateBrowserProtectedInputV2Input,
  ): Promise<{ protectedValueId: string; replay: boolean }> {
    return this.database.transaction(async (client) => {
      const project = await client.query(
        "SELECT 1 FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)",
        [input.projectId, workspaceId ?? null],
      );
      if (!project.rowCount) throw new Error("BROWSER_V2_PROJECT_NOT_FOUND");
      const existing = await client.query<{
        id: string;
        display_name: string;
        value_digest: string;
      }>(
        "SELECT id,display_name,value_digest FROM protected_values WHERE project_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [input.projectId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].display_name !== input.displayName ||
          existing.rows[0].value_digest !== digestText(input.value)
        ) {
          throw new Error("BROWSER_V2_PROTECTED_INPUT_IDEMPOTENCY_CONFLICT");
        }
        return { protectedValueId: existing.rows[0].id, replay: true };
      }
      const protectedValueId = randomUUID();
      const encrypted = this.cipher.encrypt(input.value, {
        projectId: input.projectId,
        protectedValueId,
        canonicalName: input.displayName,
        sourceKind: "user_input",
      });
      await client.query(
        `INSERT INTO protected_values(id,project_id,source_kind,display_name,external_reference,ciphertext,nonce,
           authentication_tag,value_digest,key_version,state,expires_at,idempotency_key)
         VALUES($1,$2,'user_input',$3,$4,$5,$6,$7,$8,$9,'active',now()+($10::int * interval '1 second'),$11)`,
        [
          protectedValueId,
          input.projectId,
          input.displayName,
          `protected://browser-v2/${protectedValueId}`,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authenticationTag,
          encrypted.valueDigest,
          encrypted.keyVersion,
          input.expiresInSeconds,
          input.idempotencyKey,
        ],
      );
      return { protectedValueId, replay: false };
    });
  }

  async submit(
    sessionId: string,
    input: SubmitBrowserCommandV2Input,
  ): Promise<{ commandId: string; replay: boolean; state: string }> {
    return this.database.transaction(async (client) => {
      const session = await client.query<{ run_id: string; state: string }>(
        "SELECT run_id,state FROM browser_execution_sessions WHERE id=$1 FOR UPDATE",
        [sessionId],
      );
      if (!session.rows[0] || !["active", "starting", "finalizing"].includes(session.rows[0].state))
        throw new Error("BROWSER_V2_SESSION_NOT_COMMANDABLE");
      const existing = await client.query<CommandRow>(
        "SELECT * FROM browser_commands WHERE session_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [sessionId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const proposed = safeCommand(input.command);
        const proposedDigest =
          input.command.kind === "fill" && input.command.publicValue !== undefined
            ? digestText(input.command.publicValue)
            : null;
        if (
          !isDeepStrictEqual(existing.rows[0].safe_input, proposed) ||
          existing.rows[0].protected_input_digest !== proposedDigest
        )
          throw new Error("BROWSER_V2_COMMAND_IDEMPOTENCY_CONFLICT");
        return { commandId: existing.rows[0].id, replay: true, state: existing.rows[0].state };
      }
      const ordinal = await client.query<{ next: string }>(
        "SELECT COALESCE(MAX(command_ordinal),0)+1 AS next FROM browser_commands WHERE session_id=$1",
        [sessionId],
      );
      const commandId = randomUUID();
      const encrypted =
        input.command.kind === "fill" && input.command.publicValue !== undefined
          ? this.cipher.encrypt(input.command.publicValue, {
              sessionId,
              commandId,
              field: "publicValue",
            })
          : null;
      await client.query(
        `INSERT INTO browser_commands(id,session_id,run_id,command_ordinal,idempotency_key,kind,safe_input,
           protected_input_ciphertext,protected_input_nonce,protected_input_authentication_tag,protected_input_digest,protected_input_key_version)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          commandId,
          sessionId,
          session.rows[0].run_id,
          ordinal.rows[0]!.next,
          input.idempotencyKey,
          input.command.kind,
          JSON.stringify(safeCommand(input.command)),
          encrypted?.ciphertext ?? null,
          encrypted?.nonce ?? null,
          encrypted?.authenticationTag ?? null,
          encrypted?.valueDigest ?? null,
          encrypted?.keyVersion ?? null,
        ],
      );
      await client.query("INSERT INTO browser_command_outbox(command_id) VALUES($1)", [commandId]);
      return { commandId, replay: false, state: "queued" };
    });
  }

  async assertSessionAccess(sessionId: string, workspaceId: string | undefined): Promise<void> {
    const result = await this.database.query(
      `SELECT 1 FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id
       WHERE s.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [sessionId, workspaceId ?? null],
    );
    if (!result.rowCount) throw new Error("BROWSER_V2_SESSION_NOT_FOUND");
  }

  async observe(commandId: string) {
    const result = await this.database.query<CommandRow>(
      `SELECT id,session_id AS "sessionId",run_id AS "runId",kind,state,safe_result AS result,error_code AS "errorCode",
         created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt" FROM browser_commands WHERE id=$1`,
      [commandId],
    );
    if (!result.rows[0]) throw new Error("BROWSER_V2_COMMAND_NOT_FOUND");
    return result.rows[0];
  }

  async evidenceComplete(sessionId: string): Promise<boolean> {
    const result = await this.database.query<{ state: string }>(
      "SELECT state FROM browser_evidence_streams WHERE session_id=$1",
      [sessionId],
    );
    return result.rows[0]?.state === "complete";
  }

  async safeActionLedger(sessionId: string): Promise<
    Array<{ at: string; tool: string; outcome: string; durationMs: number }>
  > {
    const result = await this.database.query<{
      kind: string;
      state: string;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT kind,state,created_at,started_at,completed_at
       FROM browser_commands WHERE session_id=$1 ORDER BY command_ordinal`,
      [sessionId],
    );
    return result.rows.map((row) => {
      const started = row.started_at ?? row.created_at;
      const completed = row.completed_at ?? started;
      return {
        at: started.toISOString(),
        tool: row.kind,
        outcome: row.state,
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
      };
    });
  }

  async pending(limit = 100): Promise<Array<{ commandId: string }>> {
    return (
      await this.database.query<{ commandId: string }>(
        `SELECT o.command_id AS "commandId" FROM browser_command_outbox o JOIN browser_commands c ON c.id=o.command_id
       WHERE o.published_at IS NULL AND c.state='queued' ORDER BY o.created_at LIMIT $1`,
        [limit],
      )
    ).rows;
  }

  async markPublished(commandId: string): Promise<void> {
    await this.database.query(
      "UPDATE browser_command_outbox SET published_at=now(),publish_attempts=publish_attempts+1,last_error=NULL WHERE command_id=$1 AND published_at IS NULL",
      [commandId],
    );
  }

  async claim(commandId: string, leaseMs = 60_000): Promise<CommandRow | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000)
      throw new Error("BROWSER_V2_COMMAND_LEASE_INVALID");
    return this.database.transaction(async (client) => {
      const result = await client.query<CommandRow>(
        "SELECT * FROM browser_commands WHERE id=$1 FOR UPDATE",
        [commandId],
      );
      const row = result.rows[0];
      if (!row || row.state === "completed" || row.state === "failed") return null;
      if (
        row.state === "running" &&
        row.claim_lease_expires_at &&
        new Date(row.claim_lease_expires_at).getTime() > Date.now()
      ) {
        throw new Error("BROWSER_V2_COMMAND_ALREADY_RUNNING");
      }
      const claimToken = randomUUID();
      const claimed = await client.query<CommandRow>(
        `UPDATE browser_commands SET state='running',started_at=COALESCE(started_at,now()),completed_at=NULL,
           error_code=NULL,claim_token=$2,claim_lease_expires_at=now()+($3::int * interval '1 millisecond'),
           attempt_count=attempt_count+1 WHERE id=$1 RETURNING *`,
        [commandId, claimToken, leaseMs],
      );
      const claimedRow = claimed.rows[0]!;
      if (
        claimedRow.protected_input_ciphertext &&
        claimedRow.protected_input_nonce &&
        claimedRow.protected_input_authentication_tag &&
        claimedRow.protected_input_digest &&
        claimedRow.protected_input_key_version &&
        claimedRow.safe_input.kind === "fill"
      ) {
        const publicValue = this.cipher.decrypt(
          {
            ciphertext: claimedRow.protected_input_ciphertext,
            nonce: claimedRow.protected_input_nonce,
            authenticationTag: claimedRow.protected_input_authentication_tag,
            valueDigest: claimedRow.protected_input_digest,
            keyVersion: claimedRow.protected_input_key_version,
          },
          { sessionId: claimedRow.session_id, commandId: claimedRow.id, field: "publicValue" },
        );
        return { ...claimedRow, safe_input: { ...claimedRow.safe_input, publicValue } };
      }
      return claimedRow;
    });
  }

  async heartbeatClaim(commandId: string, claimToken: string, leaseMs = 60_000): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_commands SET claim_lease_expires_at=now()+($3::int * interval '1 millisecond')
       WHERE id=$1 AND state='running' AND claim_token=$2 AND claim_lease_expires_at>now()`,
      [commandId, claimToken, leaseMs],
    );
    if (result.rowCount !== 1) throw new Error("BROWSER_V2_COMMAND_CLAIM_FENCED");
  }

  async complete(
    commandId: string,
    claimToken: string,
    safeResult: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_commands SET state='completed',safe_result=$3::jsonb,completed_at=now(),
         claim_token=NULL,claim_lease_expires_at=NULL WHERE id=$1 AND state='running' AND claim_token=$2`,
      [commandId, claimToken, JSON.stringify(safeResult)],
    );
    if (result.rowCount !== 1) throw new Error("BROWSER_V2_COMMAND_COMPLETION_CONFLICT");
  }

  async fail(commandId: string, claimToken: string, error: unknown): Promise<void> {
    const code = (error instanceof Error ? error.message : String(error))
      .replace(/[^A-Za-z0-9:_-]/gu, "_")
      .slice(0, 500);
    await this.database.query(
      `UPDATE browser_commands SET state='failed',error_code=$3,completed_at=now(),claim_token=NULL,
         claim_lease_expires_at=NULL WHERE id=$1 AND state='running' AND claim_token=$2`,
      [commandId, claimToken, code || "BROWSER_V2_COMMAND_FAILED"],
    );
  }

  async sessionContext(sessionId: string): Promise<{
    sessionId: string;
    runId: string;
    projectId: string;
    missionId: string;
    baseOrigin: string;
    ownerGeneration: number;
    disclosureMode: BrowserDisclosureMode;
    protectionKeyVersion: string;
  }> {
    const result = await this.database.query<{
      sessionId: string;
      runId: string;
      projectId: string;
      missionId: string;
      baseOrigin: string;
      ownerGeneration: string;
      disclosureMode: BrowserDisclosureMode;
      protectionKeyVersion: string;
    }>(
      `SELECT s.id AS "sessionId",s.run_id AS "runId",s.project_id AS "projectId",s.mission_id AS "missionId",
         e.base_origin AS "baseOrigin",s.active_owner_generation AS "ownerGeneration",
         s.disclosure_mode AS "disclosureMode",s.protection_key_version AS "protectionKeyVersion"
       FROM browser_execution_sessions s JOIN environments e ON e.id=s.environment_id
       WHERE s.id=$1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("BROWSER_V2_SESSION_NOT_FOUND");
    return {
      ...row,
      ownerGeneration: Number(row.ownerGeneration),
    };
  }

  async protectedValuesForSession(sessionId: string): Promise<Record<string, string>> {
    const generated = await this.database.query<{
      id: string;
      display_name: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
      project_id: string;
      mission_id: string;
      run_id: string;
      source_effect_id: string;
      field_path: Array<string | number>;
    }>(
      `SELECT v.id,v.display_name,v.ciphertext,v.nonce,v.authentication_tag,v.value_digest,
              v.key_version,v.project_id,v.mission_id,v.run_id,v.source_effect_id,
              lineage.field_path
       FROM protected_values v
       JOIN browser_execution_sessions s
         ON s.id=$1 AND v.project_id=s.project_id AND v.mission_id=s.mission_id AND v.run_id=s.run_id
       JOIN LATERAL (
         SELECT d.field_path
         FROM browser_outputs o
         JOIN browser_publications p ON p.id=o.publication_id
         JOIN browser_protection_decisions d
           ON d.capture_id=p.capture_id AND d.canonical_name=o.canonical_name
         WHERE o.protected_value_id=v.id
       ) lineage ON true
       WHERE v.state='active' AND v.source_kind='generated' ORDER BY v.id`,
      [sessionId],
    );
    const inputs = await this.database.query<{
      id: string;
      display_name: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
      project_id: string;
    }>(
      `SELECT v.id,v.display_name,v.ciphertext,v.nonce,v.authentication_tag,v.value_digest,
              v.key_version,v.project_id
       FROM protected_values v
       JOIN browser_session_protected_inputs i ON i.protected_value_id=v.id
       JOIN browser_execution_sessions s ON s.id=i.session_id AND s.project_id=v.project_id
       WHERE s.id=$1 AND v.state='active' AND v.source_kind='user_input'
         AND (v.expires_at IS NULL OR v.expires_at>now()) ORDER BY v.id`,
      [sessionId],
    );
    const values: Record<string, string> = {};
    for (const row of generated.rows) {
      const name = Object.hasOwn(values, row.display_name)
        ? `${row.display_name}_${row.id.slice(0, 8)}`
        : row.display_name;
      values[name] = this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.value_digest,
          keyVersion: row.key_version,
        } satisfies EncryptedProtectedValue,
        {
          projectId: row.project_id,
          missionId: row.mission_id,
          runId: row.run_id,
          effectId: row.source_effect_id,
          canonicalName: row.display_name,
        },
      );
    }
    for (const row of inputs.rows) {
      const name = Object.hasOwn(values, row.display_name)
        ? `${row.display_name}_${row.id.slice(0, 8)}`
        : row.display_name;
      values[name] = this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.value_digest,
          keyVersion: row.key_version,
        } satisfies EncryptedProtectedValue,
        {
          projectId: row.project_id,
          protectedValueId: row.id,
          canonicalName: row.display_name,
          sourceKind: "user_input",
        },
      );
    }
    return values;
  }

  async publicValuesForSession(
    sessionId: string,
  ): Promise<Array<{ value: string; allowedSinks: BrowserProtectionSink[] }>> {
    const result = await this.database.query<{
      public_value: unknown;
      allowed_sinks: string[];
    }>(
      `SELECT o.public_value,d.allowed_sinks
       FROM browser_outputs o
       JOIN browser_publications p ON p.id=o.publication_id
       JOIN browser_protection_decisions d
         ON d.capture_id=p.capture_id AND d.canonical_name=o.canonical_name
       WHERE p.session_id=$1 AND o.classification='public' AND d.label='public'
       ORDER BY o.id`,
      [sessionId],
    );
    return result.rows
      .filter(
        (row): row is { public_value: string; allowed_sinks: string[] } =>
          typeof row.public_value === "string",
      )
      .map((row) => ({
        value: row.public_value,
        allowedSinks: row.allowed_sinks.map((sink) => browserProtectionSinkSchema.parse(sink)),
      }));
  }

  async saveBrowserCheckpoint(
    sessionId: string,
    ownerGeneration: number,
    value: {
      resumeUrl: string;
      storageState: InlineStorageState;
      sessionStorage: Record<string, string>;
    },
  ): Promise<{ revision: number }> {
    const plaintext = JSON.stringify({ version: 1, ...value });
    const byteSize = Buffer.byteLength(plaintext, "utf8");
    if (byteSize < 2 || byteSize > 2 * 1024 * 1024)
      throw new Error("BROWSER_V2_CHECKPOINT_SIZE_INVALID");
    return this.database.transaction(async (client) => {
      const scope = await client.query<{
        run_id: string;
        project_id: string;
        mission_id: string;
        state: string;
        active_owner_generation: string;
        base_origin: string;
      }>(
        `SELECT s.run_id,s.project_id,s.mission_id,s.state,s.active_owner_generation,e.base_origin
         FROM browser_execution_sessions s JOIN environments e ON e.id=s.environment_id
         WHERE s.id=$1 FOR UPDATE OF s`,
        [sessionId],
      );
      const row = scope.rows[0];
      if (!row || row.state !== "active") throw new Error("BROWSER_V2_SESSION_NOT_ACTIVE");
      const resume = new URL(value.resumeUrl);
      if (resume.origin !== new URL(row.base_origin).origin)
        throw new Error("BROWSER_V2_CHECKPOINT_ORIGIN_INVALID");
      if (Number(row.active_owner_generation) !== ownerGeneration)
        throw new Error("BROWSER_V2_OWNER_FENCED");
      const owner = await client.query(
        `SELECT 1 FROM browser_owner_generations
         WHERE session_id=$1 AND generation=$2 AND state='active' AND lease_expires_at>now()`,
        [sessionId, ownerGeneration],
      );
      if (!owner.rowCount) throw new Error("BROWSER_V2_OWNER_FENCED");
      const current = await client.query<{ checkpoint_revision: string }>(
        "SELECT checkpoint_revision FROM browser_session_checkpoints WHERE session_id=$1 FOR UPDATE",
        [sessionId],
      );
      const revision = Number(current.rows[0]?.checkpoint_revision ?? 0) + 1;
      const context = checkpointContext({
        sessionId,
        runId: row.run_id,
        projectId: row.project_id,
        missionId: row.mission_id,
        revision,
        ownerGeneration,
      });
      const encrypted = this.cipher.encrypt(plaintext, context);
      await client.query(
        `INSERT INTO browser_session_checkpoints(
           session_id,run_id,project_id,mission_id,checkpoint_revision,owner_generation,resume_origin,
           resume_url_digest,ciphertext,nonce,authentication_tag,plaintext_digest,key_version,byte_size)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(session_id) DO UPDATE SET
           checkpoint_revision=excluded.checkpoint_revision,
           owner_generation=excluded.owner_generation,
           resume_origin=excluded.resume_origin,
           resume_url_digest=excluded.resume_url_digest,
           ciphertext=excluded.ciphertext,
           nonce=excluded.nonce,
           authentication_tag=excluded.authentication_tag,
           plaintext_digest=excluded.plaintext_digest,
           key_version=excluded.key_version,
           byte_size=excluded.byte_size,
           updated_at=now()`,
        [
          sessionId,
          row.run_id,
          row.project_id,
          row.mission_id,
          revision,
          ownerGeneration,
          resume.origin,
          digestText(value.resumeUrl),
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authenticationTag,
          encrypted.valueDigest,
          encrypted.keyVersion,
          byteSize,
        ],
      );
      return { revision };
    });
  }

  async loadBrowserCheckpoint(
    sessionId: string,
    ownerGeneration: number,
  ): Promise<{
    revision: number;
    resumeUrl: string;
    storageState: InlineStorageState;
    sessionStorage: Record<string, string>;
  } | null> {
    const result = await this.database.query<{
      run_id: string;
      project_id: string;
      mission_id: string;
      state: string;
      active_owner_generation: string;
      base_origin: string;
      checkpoint_revision: string;
      owner_generation: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      plaintext_digest: string;
      key_version: string;
      byte_size: number;
    }>(
      `SELECT s.run_id,s.project_id,s.mission_id,s.state,s.active_owner_generation,e.base_origin,
              c.checkpoint_revision,c.owner_generation,c.ciphertext,c.nonce,c.authentication_tag,
              c.plaintext_digest,c.key_version,c.byte_size
       FROM browser_execution_sessions s
       JOIN environments e ON e.id=s.environment_id
       LEFT JOIN browser_session_checkpoints c ON c.session_id=s.id
       WHERE s.id=$1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row || row.state !== "active") throw new Error("BROWSER_V2_SESSION_NOT_ACTIVE");
    if (Number(row.active_owner_generation) !== ownerGeneration)
      throw new Error("BROWSER_V2_OWNER_FENCED");
    if (row.checkpoint_revision === null || row.checkpoint_revision === undefined) return null;
    try {
      const revision = Number(row.checkpoint_revision);
      const checkpointOwnerGeneration = Number(row.owner_generation);
      const plaintext = this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.plaintext_digest,
          keyVersion: row.key_version,
        },
        checkpointContext({
          sessionId,
          runId: row.run_id,
          projectId: row.project_id,
          missionId: row.mission_id,
          revision,
          ownerGeneration: checkpointOwnerGeneration,
        }),
      );
      if (
        Buffer.byteLength(plaintext, "utf8") !== row.byte_size ||
        digestText(plaintext) !== row.plaintext_digest
      )
        throw new Error("digest_mismatch");
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      if (
        parsed.version !== 1 ||
        typeof parsed.resumeUrl !== "string" ||
        !isStorageState(parsed.storageState) ||
        !isStringRecord(parsed.sessionStorage) ||
        new URL(parsed.resumeUrl).origin !== new URL(row.base_origin).origin
      )
        throw new Error("shape_invalid");
      return {
        revision,
        resumeUrl: parsed.resumeUrl,
        storageState: parsed.storageState,
        sessionStorage: parsed.sessionStorage,
      };
    } catch {
      throw new Error("BROWSER_V2_CHECKPOINT_CORRUPT");
    }
  }

  async deleteBrowserCheckpoint(sessionId: string, ownerGeneration: number): Promise<void> {
    const result = await this.database.query(
      `DELETE FROM browser_session_checkpoints c USING browser_execution_sessions s
       WHERE c.session_id=$1 AND c.session_id=s.id AND s.active_owner_generation=$2`,
      [sessionId, ownerGeneration],
    );
    if ((result.rowCount ?? 0) > 1) throw new Error("BROWSER_V2_CHECKPOINT_DELETE_INVALID");
  }

  async protectedValueForBrowser(sessionId: string, protectedValueId: string): Promise<string> {
    const result = await this.database.query<{
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
      project_id: string;
      mission_id: string;
      run_id: string;
      source_effect_id: string;
      canonical_name: string;
    }>(
      `SELECT v.ciphertext,v.nonce,v.authentication_tag,v.value_digest,v.key_version,v.project_id,v.mission_id,v.run_id,
         v.source_effect_id,o.canonical_name FROM protected_values v JOIN browser_outputs o ON o.protected_value_id=v.id
       JOIN browser_execution_sessions s ON s.project_id=v.project_id AND s.mission_id=v.mission_id AND s.run_id=v.run_id
       WHERE s.id=$1 AND v.id=$2 AND v.state='active'`,
      [sessionId, protectedValueId],
    );
    const row = result.rows[0];
    if (row) {
      return this.cipher.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          valueDigest: row.value_digest,
          keyVersion: row.key_version,
        } satisfies EncryptedProtectedValue,
        {
          projectId: row.project_id,
          missionId: row.mission_id,
          runId: row.run_id,
          effectId: row.source_effect_id,
          canonicalName: row.canonical_name,
        },
      );
    }
    const userInput = await this.database.query<{
      id: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      value_digest: string;
      key_version: string;
      project_id: string;
      display_name: string;
    }>(
      `SELECT v.id,v.ciphertext,v.nonce,v.authentication_tag,v.value_digest,v.key_version,v.project_id,v.display_name
       FROM protected_values v JOIN browser_session_protected_inputs b ON b.protected_value_id=v.id
       JOIN browser_execution_sessions s ON s.id=b.session_id AND s.project_id=v.project_id
       WHERE s.id=$1 AND v.id=$2 AND v.source_kind='user_input' AND v.state='active'
         AND (v.expires_at IS NULL OR v.expires_at>now())`,
      [sessionId, protectedValueId],
    );
    const input = userInput.rows[0];
    if (!input) throw new Error("BROWSER_V2_PROTECTED_VALUE_UNAVAILABLE");
    return this.cipher.decrypt(
      {
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        authenticationTag: input.authentication_tag,
        valueDigest: input.value_digest,
        keyVersion: input.key_version,
      } satisfies EncryptedProtectedValue,
      {
        projectId: input.project_id,
        protectedValueId: input.id,
        canonicalName: input.display_name,
        sourceKind: "user_input",
      },
    );
  }

  async completeEvidence(input: {
    sessionId: string;
    runId: string;
    chainHead: string;
    chunkCount: number;
    totalBytes: number;
    replayObjectKey: string;
    videoObjectKey?: string;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,
         replay_artifact_key,video_artifact_key,retention_expires_at,completed_at)
       VALUES(gen_random_uuid(),$1,$2,'complete',$3,$4,$5,$6,$7,now()+interval '30 days',now())
       ON CONFLICT(session_id) DO NOTHING`,
      [
        input.sessionId,
        input.runId,
        input.chainHead,
        input.chunkCount,
        input.totalBytes,
        input.replayObjectKey,
        input.videoObjectKey ?? null,
      ],
    );
  }
}

function checkpointContext(input: {
  sessionId: string;
  runId: string;
  projectId: string;
  missionId: string;
  revision: number;
  ownerGeneration: number;
}): Record<string, string> {
  return {
    purpose: "browser_session_checkpoint",
    sessionId: input.sessionId,
    runId: input.runId,
    projectId: input.projectId,
    missionId: input.missionId,
    revision: String(input.revision),
    ownerGeneration: String(input.ownerGeneration),
  };
}

function isStorageState(value: unknown): value is InlineStorageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.cookies) && Array.isArray(record.origins);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function safeCommand(command: BrowserCommandV2): BrowserCommandV2 {
  return command.kind === "fill" && command.publicValue !== undefined
    ? { ...command, publicValue: "[PROTECTED:COMMAND_INPUT]" }
    : command;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
