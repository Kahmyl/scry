import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { BrowserProtectionDecision } from "@scry/contracts";
import type { PoolClient, QueryResultRow } from "pg";

import { Database } from "../infrastructure/database.js";
import { BrowserProtectedValueCipher } from "./protected-value-cipher.js";
import {
  BROWSER_RUNTIME_CAPABILITY_VERSION,
  BROWSER_V2_SCHEMA_VERSION,
} from "./browser-runtime-capability.js";
import {
  browserV2CatalogFingerprint,
  loadBrowserV2SchemaManifest,
} from "./browser-v2-schema-manifest.js";

const CAPABILITY_VERSION = BROWSER_RUNTIME_CAPABILITY_VERSION;

type EffectClass = "authentication" | "business";
type MutationOutcome = "pending" | "applied" | "not_applied" | "unknown";

interface SessionRow extends QueryResultRow {
  id: string;
  run_id: string;
  project_id: string;
  mission_id: string;
  state: string;
  active_owner_generation: string;
  authentication_commit_limit: number;
  authentication_commits_used: number;
  business_commit_limit: number;
  business_commits_used: number;
  runtime_capability_version: string;
  protection_key_version: string;
}

interface EffectRow extends QueryResultRow {
  id: string;
  session_id: string;
  run_id: string;
  project_id: string;
  mission_id: string;
  effect_ordinal: string;
  idempotency_key: string;
  effect_class: EffectClass;
  owner_generation: string;
  document_epoch: string;
  expected_origin: string;
  target_digest: string;
  action_digest: string;
  intent_summary: string;
  admission_state: "admitted" | "rejected";
  dispatch_state: "not_started" | "started" | "acknowledged" | "unknown";
  capture_state: "not_started" | "durable" | "unavailable" | "expired" | "corrupt";
  publication_state: "not_started" | "published" | "discarded" | "failed";
  mutation_outcome: MutationOutcome;
  determination_source: string | null;
  response_status: number | null;
}

export interface CreateBrowserSessionInput {
  id: string;
  runId: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  environmentId: string;
  agentSessionId: string;
  authenticationCommitLimit: number;
  businessCommitLimit: number;
  allowedFirstPartyOrigins: string[];
  allowedServiceOrigins?: string[];
  idempotencyKey: string;
}

export interface AdmitBrowserEffectInput {
  sessionId: string;
  ownerGeneration: number;
  documentEpoch: number;
  idempotencyKey: string;
  effectClass: EffectClass;
  expectedOrigin: string;
  targetDigest: string;
  actionDigest: string;
  intentSummary: string;
}

export interface RecoverAdmittedBrowserEffectInput {
  sessionId: string;
  idempotencyKey: string;
  effectClass: EffectClass;
  expectedOrigin: string;
  intentSummary: string;
}

export interface PublishBrowserOutputsInput {
  effectId: string;
  ownerGeneration: number;
  captureId: string;
  selectionDigest: string;
  publicOutputs: Record<string, string | number | boolean | null>;
  protectedOutputs: Record<string, string>;
  decisions: BrowserProtectionDecision[];
}

@Injectable()
export class BrowserExecutionRepository {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(BrowserProtectedValueCipher) private readonly cipher: BrowserProtectedValueCipher,
  ) {}

  async assertCompatibleBaseline(): Promise<void> {
    const [manifest, result, catalogFingerprint] = await Promise.all([
      loadBrowserV2SchemaManifest(),
      this.database.query<{
        schema_version: number;
        schema_fingerprint: string;
        catalog_fingerprint: string | null;
        runtime_capability_version: string;
      }>(
        `SELECT schema_version,schema_fingerprint,catalog_fingerprint,runtime_capability_version
         FROM schema_baseline WHERE singleton=true`,
      ),
      browserV2CatalogFingerprint(this.database.pool),
    ]);
    const row = result.rows[0];
    if (
      manifest.schemaVersion !== BROWSER_V2_SCHEMA_VERSION ||
      !row ||
      row.schema_version !== BROWSER_V2_SCHEMA_VERSION ||
      row.schema_fingerprint !== manifest.schemaFingerprint ||
      row.catalog_fingerprint !== catalogFingerprint ||
      row.runtime_capability_version !== CAPABILITY_VERSION
    ) {
      throw new Error("BROWSER_V2_SCHEMA_CAPABILITY_MISMATCH");
    }
    if (process.env.BROWSER_V2_REQUIRE_ACTIVATED_CUTOVER === "true") {
      const activation = await this.database.query(
        "SELECT 1 FROM identity_import_receipts WHERE mode='permanent' AND state='active' LIMIT 1",
      );
      if (!activation.rowCount) throw new Error("BROWSER_V2_CUTOVER_NOT_ACTIVATED");
    }
  }

  async recoverAdmittedEffect(
    input: RecoverAdmittedBrowserEffectInput,
  ): Promise<{ effectId: string } | null> {
    const result = await this.database.query<EffectRow>(
      `SELECT * FROM browser_effects
       WHERE session_id=$1 AND idempotency_key=$2 AND admission_state='admitted'`,
      [input.sessionId, input.idempotencyKey],
    );
    const effect = result.rows[0];
    if (!effect) return null;
    if (
      effect.effect_class !== input.effectClass ||
      effect.expected_origin !== input.expectedOrigin ||
      effect.intent_summary !== input.intentSummary
    )
      throw new Error("BROWSER_V2_EFFECT_IDEMPOTENCY_CONFLICT");
    return { effectId: effect.id };
  }

  async createSession(input: CreateBrowserSessionInput): Promise<SessionRow> {
    await this.assertCompatibleBaseline();
    return this.database.transaction(async (client) => {
      const existing = await client.query<SessionRow>(
        "SELECT * FROM browser_execution_sessions WHERE run_id=$1 FOR UPDATE",
        [input.runId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.id !== input.id ||
          row.project_id !== input.projectId ||
          row.mission_id !== input.missionId ||
          input.idempotencyKey.length === 0
        ) {
          throw new Error("BROWSER_V2_SESSION_IDEMPOTENCY_CONFLICT");
        }
        return row;
      }
      const environment = await client.query<{ disclosure_mode: string }>(
        "SELECT disclosure_mode FROM environments WHERE id=$1 AND project_id=$2",
        [input.environmentId, input.projectId],
      );
      if (!environment.rows[0]) throw new Error("BROWSER_V2_ENVIRONMENT_NOT_FOUND");
      const inserted = await client.query<SessionRow>(
        `INSERT INTO browser_execution_sessions(
           id,run_id,project_id,mission_id,objective_id,environment_id,agent_session_id,
           authentication_commit_limit,business_commit_limit,allowed_first_party_origins,
           allowed_service_origins,runtime_capability_version,protection_key_version,
           disclosure_mode,idempotency_key,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,'active') RETURNING *`,
        [
          input.id,
          input.runId,
          input.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.agentSessionId,
          input.authenticationCommitLimit,
          input.businessCommitLimit,
          JSON.stringify(input.allowedFirstPartyOrigins),
          JSON.stringify(input.allowedServiceOrigins ?? []),
          CAPABILITY_VERSION,
          this.cipher.activeKeyVersion(),
          environment.rows[0].disclosure_mode,
          input.idempotencyKey,
        ],
      );
      await client.query(
        "INSERT INTO browser_execution_outbox(session_id,runtime_capability_version) VALUES($1,$2)",
        [input.id, CAPABILITY_VERSION],
      );
      return required(inserted.rows[0], "BROWSER_V2_SESSION_INSERT_FAILED");
    });
  }

  async claimOwner(
    sessionId: string,
    workerId: string,
    leaseMs: number,
    reason = "claim",
  ): Promise<{ generation: number; leaseToken: string; fencingToken: number }> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000)
      throw new Error("BROWSER_V2_OWNER_LEASE_INVALID");
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId);
      if (session.state !== "active") throw new Error("BROWSER_V2_SESSION_NOT_ACTIVE");
      const now = new Date();
      const active = await client.query<{ generation: number; lease_expires_at: Date }>(
        "SELECT generation,lease_expires_at FROM browser_owner_generations WHERE session_id=$1 AND state='active' FOR UPDATE",
        [sessionId],
      );
      if (active.rows[0] && new Date(active.rows[0].lease_expires_at).getTime() > now.getTime()) {
        throw new Error("BROWSER_V2_OWNER_ACTIVE");
      }
      await client.query(
        `UPDATE browser_owner_generations SET state='lost',terminal_at=$2,replacement_reason=$3
         WHERE session_id=$1 AND state='active'`,
        [sessionId, now, reason],
      );
      const replacedGeneration = active.rows[0]?.generation;
      if (replacedGeneration !== undefined) {
        const interrupted = await client.query<EffectRow>(
          `SELECT * FROM browser_effects
           WHERE session_id=$1 AND owner_generation=$2 AND mutation_outcome='pending'
           ORDER BY effect_ordinal FOR UPDATE`,
          [sessionId, replacedGeneration],
        );
        for (const effect of interrupted.rows) {
          if (effect.dispatch_state === "not_started") {
            await client.query(
              `UPDATE browser_effects SET mutation_outcome='not_applied',determination_source='owner_replaced_before_dispatch',
                 terminal_at=$2,updated_at=$2 WHERE id=$1`,
              [effect.id, now],
            );
            const countColumn =
              effect.effect_class === "authentication"
                ? "authentication_commits_used"
                : "business_commits_used";
            await client.query(
              `UPDATE browser_execution_sessions SET ${countColumn}=GREATEST(${countColumn}-1,0),updated_at=$2 WHERE id=$1`,
              [sessionId, now],
            );
            await this.appendEffectEvent(client, effect.id, sessionId, "not_applied", {
              source: "owner_replaced_before_dispatch",
            });
          } else {
            await client.query(
              `UPDATE browser_effects SET mutation_outcome='unknown',determination_source='owner_replaced_after_dispatch',
                 dispatch_state=CASE WHEN dispatch_state='started' THEN 'unknown' ELSE dispatch_state END,
                 terminal_at=$2,updated_at=$2 WHERE id=$1`,
              [effect.id, now],
            );
            await this.appendEffectEvent(client, effect.id, sessionId, "unknown", {
              source: "owner_replaced_after_dispatch",
            });
          }
        }
      }
      const generation = Number(session.active_owner_generation) + 1;
      const leaseToken = randomUUID();
      await client.query(
        `INSERT INTO browser_owner_generations(
           session_id,generation,worker_id,lease_token,fencing_token,state,lease_expires_at,
           runtime_capability_version)
         VALUES($1,$2,$3,$4,$2,'active',$5,$6)`,
        [
          sessionId,
          generation,
          workerId,
          leaseToken,
          new Date(now.getTime() + leaseMs),
          CAPABILITY_VERSION,
        ],
      );
      await client.query(
        "UPDATE browser_execution_sessions SET active_owner_generation=$2,updated_at=now() WHERE id=$1",
        [sessionId, generation],
      );
      return { generation, leaseToken, fencingToken: generation };
    });
  }

  async heartbeatOwner(
    sessionId: string,
    generation: number,
    leaseToken: string,
    leaseMs: number,
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_owner_generations SET heartbeat_at=now(),lease_expires_at=now()+($4::int * interval '1 millisecond')
       WHERE session_id=$1 AND generation=$2 AND lease_token=$3 AND state='active' AND lease_expires_at>now()`,
      [sessionId, generation, leaseToken, leaseMs],
    );
    if (result.rowCount !== 1) throw new Error("BROWSER_V2_OWNER_FENCED");
  }

  async releaseOwner(sessionId: string, generation: number, leaseToken: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_owner_generations SET state='released',terminal_at=now(),replacement_reason='session_closed'
       WHERE session_id=$1 AND generation=$2 AND lease_token=$3 AND state='active'`,
      [sessionId, generation, leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("BROWSER_V2_OWNER_FENCED");
  }

  async assertNoPendingEffectOutcomes(sessionId: string): Promise<void> {
    const pending = await this.database.query<{ id: string }>(
      `SELECT id FROM browser_effects
       WHERE session_id=$1 AND mutation_outcome IN ('pending','unknown')
       ORDER BY effect_ordinal`,
      [sessionId],
    );
    if (pending.rows.length > 0) {
      throw new Error(
        `BROWSER_V2_EFFECT_OUTCOME_PENDING:${pending.rows.map(({ id }) => id).join(",")}`,
      );
    }
  }

  async prepareFailureFinalization(sessionId: string, ownerGeneration: number): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.lockOwnedSession(client, sessionId, ownerGeneration);
      const unsettled = await client.query<{ id: string }>(
        "SELECT id FROM browser_captures WHERE session_id=$1 AND state='durable' ORDER BY captured_at FOR UPDATE",
        [sessionId],
      );
      if (unsettled.rows.length > 0) {
        throw new Error(
          `BROWSER_V2_CAPTURES_UNSETTLED:${unsettled.rows.map(({ id }) => id).join(",")}`,
        );
      }
      const interrupted = await client.query<EffectRow>(
        `SELECT * FROM browser_effects WHERE session_id=$1 AND mutation_outcome='pending'
         ORDER BY effect_ordinal FOR UPDATE`,
        [sessionId],
      );
      for (const effect of interrupted.rows) {
        if (effect.dispatch_state === "not_started") {
          await client.query(
            `UPDATE browser_effects SET mutation_outcome='not_applied',determination_source='failure_finalized_before_dispatch',
               terminal_at=now(),updated_at=now() WHERE id=$1`,
            [effect.id],
          );
          const countColumn =
            effect.effect_class === "authentication"
              ? "authentication_commits_used"
              : "business_commits_used";
          await client.query(
            `UPDATE browser_execution_sessions SET ${countColumn}=GREATEST(${countColumn}-1,0),updated_at=now() WHERE id=$1`,
            [sessionId],
          );
          await this.appendEffectEvent(client, effect.id, sessionId, "not_applied", {
            source: "failure_finalized_before_dispatch",
          });
        } else {
          await client.query(
            `UPDATE browser_effects SET mutation_outcome='unknown',determination_source='failure_finalized_after_dispatch',
               dispatch_state=CASE WHEN dispatch_state='started' THEN 'unknown' ELSE dispatch_state END,
               terminal_at=now(),updated_at=now() WHERE id=$1`,
            [effect.id],
          );
          await this.appendEffectEvent(client, effect.id, sessionId, "unknown", {
            source: "failure_finalized_after_dispatch",
          });
        }
      }
    });
  }

  async admitEffect(
    input: AdmitBrowserEffectInput,
  ): Promise<{ replay: boolean; effect: EffectRow }> {
    return this.database.transaction(async (client) => {
      const session = await this.lockOwnedSession(client, input.sessionId, input.ownerGeneration);
      const existing = await client.query<EffectRow>(
        "SELECT * FROM browser_effects WHERE session_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [input.sessionId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const effect = existing.rows[0];
        if (!matchesEffect(effect, input))
          throw new Error("BROWSER_V2_EFFECT_IDEMPOTENCY_CONFLICT");
        return { replay: true, effect };
      }
      const unresolved = await client.query<{ id: string }>(
        `SELECT id FROM browser_effects
         WHERE session_id=$1 AND effect_class=$2 AND mutation_outcome IN ('pending','unknown')
         LIMIT 1 FOR UPDATE`,
        [input.sessionId, input.effectClass],
      );
      if (unresolved.rows[0])
        throw new Error(`BROWSER_V2_EFFECT_UNRESOLVED:${unresolved.rows[0].id}`);

      const limit =
        input.effectClass === "authentication"
          ? session.authentication_commit_limit
          : session.business_commit_limit;
      const used =
        input.effectClass === "authentication"
          ? session.authentication_commits_used
          : session.business_commits_used;
      if (used >= limit)
        throw new Error(`BROWSER_V2_${input.effectClass.toUpperCase()}_BUDGET_EXHAUSTED`);
      const countColumn =
        input.effectClass === "authentication"
          ? "authentication_commits_used"
          : "business_commits_used";
      await client.query(
        `UPDATE browser_execution_sessions SET ${countColumn}=${countColumn}+1,updated_at=now() WHERE id=$1`,
        [input.sessionId],
      );
      const ordinal = await client.query<{ next: string }>(
        "SELECT COALESCE(MAX(effect_ordinal),0)+1 AS next FROM browser_effects WHERE session_id=$1",
        [input.sessionId],
      );
      const effectId = randomUUID();
      const inserted = await client.query<EffectRow>(
        `INSERT INTO browser_effects(
           id,session_id,run_id,project_id,mission_id,effect_ordinal,idempotency_key,effect_class,
           owner_generation,document_epoch,expected_origin,target_digest,action_digest,intent_summary,admission_state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'admitted') RETURNING *`,
        [
          effectId,
          input.sessionId,
          session.run_id,
          session.project_id,
          session.mission_id,
          required(ordinal.rows[0], "BROWSER_V2_EFFECT_ORDINAL_FAILED").next,
          input.idempotencyKey,
          input.effectClass,
          input.ownerGeneration,
          input.documentEpoch,
          input.expectedOrigin,
          input.targetDigest,
          input.actionDigest,
          input.intentSummary,
        ],
      );
      await this.appendEffectEvent(client, effectId, input.sessionId, "admitted", {});
      return {
        replay: false,
        effect: required(inserted.rows[0], "BROWSER_V2_EFFECT_INSERT_FAILED"),
      };
    });
  }

  async markDispatchStarted(effectId: string, ownerGeneration: number): Promise<EffectRow> {
    return this.transition(effectId, ownerGeneration, async (client, effect) => {
      if (effect.dispatch_state === "started") return effect;
      if (effect.dispatch_state !== "not_started" || effect.mutation_outcome !== "pending")
        throw new Error("BROWSER_V2_DISPATCH_TRANSITION_INVALID");
      const updated = await client.query<EffectRow>(
        "UPDATE browser_effects SET dispatch_state='started',dispatch_started_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [effectId],
      );
      await this.appendEffectEvent(client, effectId, effect.session_id, "dispatch_started", {});
      return required(updated.rows[0], "BROWSER_V2_EFFECT_UPDATE_FAILED");
    });
  }

  async markUnknown(effectId: string, ownerGeneration: number, reason: string): Promise<EffectRow> {
    return this.determine(effectId, ownerGeneration, "unknown", reason);
  }

  async determine(
    effectId: string,
    ownerGeneration: number,
    outcome: Exclude<MutationOutcome, "pending">,
    source: string,
  ): Promise<EffectRow> {
    return this.transition(effectId, ownerGeneration, async (client, effect) => {
      if (effect.mutation_outcome === outcome && effect.determination_source === source)
        return effect;
      if (effect.dispatch_state === "not_started" && outcome !== "not_applied")
        throw new Error("BROWSER_V2_OUTCOME_UNPROVEN");
      if (outcome === "not_applied" && ["started", "unknown"].includes(effect.dispatch_state))
        throw new Error("BROWSER_V2_NOT_APPLIED_UNPROVEN");
      if (outcome === "applied" && effect.dispatch_state !== "acknowledged")
        throw new Error("BROWSER_V2_APPLIED_UNPROVEN");
      if (effect.mutation_outcome !== "pending" && effect.mutation_outcome !== "unknown")
        throw new Error("BROWSER_V2_EFFECT_ALREADY_TERMINAL");
      const updated = await client.query<EffectRow>(
        `UPDATE browser_effects SET mutation_outcome=$2,determination_source=$3,terminal_at=now(),updated_at=now(),
           dispatch_state=CASE WHEN $2='unknown' AND dispatch_state='started' THEN 'unknown' ELSE dispatch_state END
         WHERE id=$1 RETURNING *`,
        [effectId, outcome, source],
      );
      if (effect.dispatch_state === "not_started" && outcome === "not_applied") {
        const countColumn =
          effect.effect_class === "authentication"
            ? "authentication_commits_used"
            : "business_commits_used";
        await client.query(
          `UPDATE browser_execution_sessions SET ${countColumn}=GREATEST(${countColumn}-1,0),updated_at=now() WHERE id=$1`,
          [effect.session_id],
        );
      }
      await this.appendEffectEvent(
        client,
        effectId,
        effect.session_id,
        outcome === "unknown" ? "unknown" : outcome,
        { source },
      );
      return required(updated.rows[0], "BROWSER_V2_EFFECT_UPDATE_FAILED");
    });
  }

  async registerCapture(input: {
    effectId: string;
    ownerGeneration: number;
    captureId: string;
    evidenceVersion: number;
    objectKey: string;
    ciphertextDigest: string;
    authenticatedMetadata: Record<string, unknown>;
    contentClass: "http_json" | "http_text" | "http_empty" | "http_binary" | "dom_region";
    byteSize: number;
    structuralIndex: unknown[];
    capturedAt: Date;
    expiresAt: Date;
    encryptedPayload: Buffer;
    encryptedPayloadDigest: string;
    responseStatus?: number;
  }): Promise<void> {
    await this.transition(input.effectId, input.ownerGeneration, async (client, effect) => {
      if (
        input.encryptedPayload.length === 0 ||
        createHash("sha256").update(input.encryptedPayload).digest("hex") !==
          input.encryptedPayloadDigest
      )
        throw new Error("BROWSER_V2_CAPTURE_ENVELOPE_INVALID");
      const ownsHttpResponse = input.responseStatus !== undefined;
      if (ownsHttpResponse) {
        if (
          !Number.isInteger(input.responseStatus) ||
          input.responseStatus! < 100 ||
          input.responseStatus! > 599 ||
          !["started", "unknown", "acknowledged"].includes(effect.dispatch_state)
        )
          throw new Error("BROWSER_V2_RESPONSE_TRANSITION_INVALID");
        if (
          effect.dispatch_state === "acknowledged" &&
          effect.response_status !== input.responseStatus
        )
          throw new Error("BROWSER_V2_RESPONSE_CONFLICT");
      } else if (effect.dispatch_state !== "acknowledged") {
        throw new Error("BROWSER_V2_CAPTURE_BEFORE_RESPONSE");
      }
      const existing = await client.query<{
        id: string;
        ciphertext_digest: string;
        encrypted_payload_digest: string;
      }>(
        "SELECT id,ciphertext_digest,encrypted_payload_digest FROM browser_captures WHERE id=$1 FOR UPDATE",
        [input.captureId],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].ciphertext_digest !== input.ciphertextDigest ||
          existing.rows[0].encrypted_payload_digest !== input.encryptedPayloadDigest
        )
          throw new Error("BROWSER_V2_CAPTURE_CONFLICT");
        return effect;
      }
      await client.query(
        `INSERT INTO browser_captures(id,effect_id,session_id,evidence_version,object_key,ciphertext_digest,
           authenticated_metadata,content_class,byte_size,state,structural_index,captured_at,expires_at,
           encrypted_payload,encrypted_payload_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'durable',$10::jsonb,$11,$12,$13,$14)`,
        [
          input.captureId,
          input.effectId,
          effect.session_id,
          input.evidenceVersion,
          input.objectKey,
          input.ciphertextDigest,
          JSON.stringify(input.authenticatedMetadata),
          input.contentClass,
          input.byteSize,
          JSON.stringify(input.structuralIndex),
          input.capturedAt,
          input.expiresAt,
          input.encryptedPayload,
          input.encryptedPayloadDigest,
        ],
      );
      if (ownsHttpResponse && effect.dispatch_state !== "acknowledged") {
        await client.query(
          `UPDATE browser_effects
              SET dispatch_state='acknowledged',response_status=$2,response_observed_at=now(),
                  capture_state='durable',updated_at=now()
            WHERE id=$1`,
          [input.effectId, input.responseStatus],
        );
        await this.appendEffectEvent(client, input.effectId, effect.session_id, "response_observed", {
          status: input.responseStatus,
        });
      } else {
        await client.query(
          "UPDATE browser_effects SET capture_state='durable',updated_at=now() WHERE id=$1",
          [input.effectId],
        );
      }
      await this.appendEffectEvent(client, input.effectId, effect.session_id, "capture_durable", {
        captureId: input.captureId,
      });
      return effect;
    });
  }

  async durableCapturesForSession(sessionId: string): Promise<
    Array<{
      captureId: string;
      encryptedPayload: Buffer;
      encryptedPayloadDigest: string;
      storedReceipt: Record<string, unknown>;
    }>
  > {
    const result = await this.database.query<{
      capture_id: string;
      encrypted_payload: Buffer;
      encrypted_payload_digest: string;
      authenticated_metadata: { storedReceipt?: Record<string, unknown> };
    }>(
      `SELECT id AS capture_id,encrypted_payload,encrypted_payload_digest,authenticated_metadata
         FROM browser_captures
        WHERE session_id=$1 AND state='durable'
        ORDER BY captured_at,id`,
      [sessionId],
    );
    return result.rows.map((row) => {
      if (!row.authenticated_metadata.storedReceipt)
        throw new Error("BROWSER_V2_CAPTURE_RECEIPT_MISSING");
      return {
        captureId: row.capture_id,
        encryptedPayload: row.encrypted_payload,
        encryptedPayloadDigest: row.encrypted_payload_digest,
        storedReceipt: row.authenticated_metadata.storedReceipt,
      };
    });
  }

  async publishOutputs(
    input: PublishBrowserOutputsInput,
  ): Promise<{ publicationId: string; protectedReferences: Record<string, string> }> {
    return this.database.transaction(async (client) => {
      const effect = await this.lockEffect(client, input.effectId);
      await this.assertOwner(client, effect.session_id, input.ownerGeneration);
      if (effect.capture_state !== "durable") throw new Error("BROWSER_V2_CAPTURE_NOT_DURABLE");
      const decisionSetDigest = createHash("sha256")
        .update(JSON.stringify(input.decisions))
        .digest("hex");
      const existing = await client.query<{
        id: string;
        selection_digest: string;
        decision_set_digest: string;
      }>(
        "SELECT id,selection_digest,decision_set_digest FROM browser_publications WHERE capture_id=$1 FOR UPDATE",
        [input.captureId],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].selection_digest !== input.selectionDigest ||
          existing.rows[0].decision_set_digest !== decisionSetDigest
        )
          throw new Error("BROWSER_V2_PUBLICATION_CONFLICT");
        return {
          publicationId: existing.rows[0].id,
          protectedReferences: await this.protectedReferences(client, effect.id),
        };
      }
      const outputEntries = [
        ...Object.entries(input.publicOutputs),
        ...Object.entries(input.protectedOutputs),
      ];
      if (outputEntries.length === 0) throw new Error("BROWSER_V2_OUTPUTS_REQUIRED");
      if (new Set(outputEntries.map(([name]) => name)).size !== outputEntries.length)
        throw new Error("BROWSER_V2_OUTPUT_NAME_DUPLICATE");
      if (input.decisions.length !== outputEntries.length)
        throw new Error("BROWSER_V2_PROTECTION_DECISION_SET_INCOMPLETE");
      const decisionNames = new Set(input.decisions.map((decision) => decision.key));
      if (
        decisionNames.size !== input.decisions.length ||
        outputEntries.some(([name]) => !decisionNames.has(name)) ||
        input.decisions.some(
          (decision) =>
            decision.captureId !== input.captureId || decision.effectId !== input.effectId,
        )
      )
        throw new Error("BROWSER_V2_PROTECTION_DECISION_SET_INVALID");
      const capture = await client.query<{
        id: string;
        structural_index: Array<{ path: unknown }>;
      }>(
        `SELECT id,structural_index FROM browser_captures
         WHERE id=$1 AND effect_id=$2 AND state='durable' AND expires_at>now() FOR UPDATE`,
        [input.captureId, input.effectId],
      );
      if (!capture.rows[0]) throw new Error("BROWSER_V2_CAPTURE_UNAVAILABLE");
      const capturedPaths = new Set(
        capture.rows[0].structural_index.map((node) => JSON.stringify(node.path)),
      );
      const disclosure = await client.query<{ disclosure_mode: string }>(
        "SELECT disclosure_mode FROM browser_execution_sessions WHERE id=$1",
        [effect.session_id],
      );
      for (const decision of input.decisions) {
        if (!capturedPaths.has(JSON.stringify(decision.path)))
          throw new Error("BROWSER_V2_PROTECTION_DECISION_PATH_INVALID");
        const publicValue = input.publicOutputs[decision.key];
        const protectedValue = input.protectedOutputs[decision.key];
        if (
          (decision.label === "public" &&
            (publicValue === undefined ||
              protectedValue !== undefined ||
              !decision.allowedSinks.includes("database_safe_field") ||
              digestOutputValue(publicValue) !== decision.valueDigest)) ||
          (decision.label === "protected" &&
            (protectedValue === undefined ||
              publicValue !== undefined ||
              digestOutputValue(protectedValue) !== decision.valueDigest))
        )
          throw new Error("BROWSER_V2_PROTECTION_DECISION_VALUE_INVALID");
        if (decision.label === "public") {
          if (
            disclosure.rows[0]?.disclosure_mode !== "trusted_application_output" ||
            decision.publicAdmissionMode !== "trusted_application_output" ||
            !decision.publicSemantic ||
            !decision.publicEvidenceDigest ||
            !decision.publicProposalDigest
          )
            throw new Error("BROWSER_V2_PUBLIC_ADMISSION_INVALID");
        }
      }
      const publicationId = randomUUID();
      await client.query(
        `INSERT INTO browser_publications(
           id,capture_id,effect_id,session_id,selection_digest,decision_set_digest,output_count)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          publicationId,
          input.captureId,
          input.effectId,
          effect.session_id,
          input.selectionDigest,
          decisionSetDigest,
          outputEntries.length,
        ],
      );
      for (const decision of input.decisions) {
        await client.query(
          `INSERT INTO browser_protection_decisions(
             capture_id,effect_id,session_id,decision_revision,field_path,canonical_name,label,
             allowed_sinks,value_digest,decision_digest,reason_code,public_admission_mode,
             public_semantic,public_evidence_digest,public_proposal_digest)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
          [
            input.captureId,
            input.effectId,
            effect.session_id,
            decision.decisionRevision,
            JSON.stringify(decision.path),
            decision.key,
            decision.label,
            JSON.stringify(decision.allowedSinks),
            decision.valueDigest,
            decision.decisionDigest,
            decision.reason,
            decision.publicAdmissionMode ?? null,
            decision.publicSemantic ?? null,
            decision.publicEvidenceDigest ?? null,
            decision.publicProposalDigest ?? null,
          ],
        );
      }
      for (const [canonicalName, value] of Object.entries(input.publicOutputs)) {
        await client.query(
          `INSERT INTO browser_outputs(publication_id,effect_id,project_id,canonical_name,classification,public_value)
           VALUES($1,$2,$3,$4,'public',$5::jsonb)`,
          [publicationId, input.effectId, effect.project_id, canonicalName, JSON.stringify(value)],
        );
      }
      const protectedReferences: Record<string, string> = {};
      for (const [canonicalName, value] of Object.entries(input.protectedOutputs)) {
        const protectedValueId = randomUUID();
        const encrypted = this.cipher.encrypt(value, {
          projectId: effect.project_id,
          missionId: effect.mission_id,
          runId: effect.run_id,
          effectId: effect.id,
          canonicalName,
        });
        await client.query(
          `INSERT INTO protected_values(id,project_id,mission_id,run_id,source_effect_id,source_kind,display_name,
             external_reference,ciphertext,nonce,authentication_tag,value_digest,key_version)
           VALUES($1,$2,$3,$4,$5,'generated',$6,$7,$8,$9,$10,$11,$12)`,
          [
            protectedValueId,
            effect.project_id,
            effect.mission_id,
            effect.run_id,
            effect.id,
            canonicalName,
            `protected://browser-v2/${protectedValueId}`,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authenticationTag,
            encrypted.valueDigest,
            encrypted.keyVersion,
          ],
        );
        await client.query(
          `INSERT INTO browser_outputs(publication_id,effect_id,project_id,canonical_name,classification,protected_value_id)
           VALUES($1,$2,$3,$4,'protected',$5)`,
          [publicationId, input.effectId, effect.project_id, canonicalName, protectedValueId],
        );
        protectedReferences[canonicalName] = protectedValueId;
      }
      await client.query("UPDATE browser_captures SET state='published',structural_index='[]'::jsonb,encrypted_payload=NULL,encrypted_payload_digest=NULL WHERE id=$1", [
        input.captureId,
      ]);
      await client.query(
        "UPDATE browser_effects SET publication_state='published',updated_at=now() WHERE id=$1",
        [input.effectId],
      );
      await this.appendEffectEvent(client, input.effectId, effect.session_id, "published", {
        publicationId,
      });
      return { publicationId, protectedReferences };
    });
  }

  async discardCapture(input: {
    effectId: string;
    ownerGeneration: number;
    captureId: string;
  }): Promise<void> {
    await this.transition(input.effectId, input.ownerGeneration, async (client, effect) => {
      if (effect.capture_state !== "durable") throw new Error("BROWSER_V2_CAPTURE_NOT_DURABLE");
      const capture = await client.query<{
        state: string;
        structural_index: Array<{ path: unknown; kind?: string; length?: number }>;
      }>(
        "SELECT state,structural_index FROM browser_captures WHERE id=$1 AND effect_id=$2 FOR UPDATE",
        [input.captureId, input.effectId],
      );
      const row = capture.rows[0];
      if (!row) throw new Error("BROWSER_V2_CAPTURE_UNAVAILABLE");
      if (row.state === "deleted") return effect;
      if (row.state !== "durable") throw new Error("BROWSER_V2_CAPTURE_ALREADY_SETTLED");
      const publication = await client.query(
        "SELECT 1 FROM browser_publications WHERE capture_id=$1",
        [input.captureId],
      );
      if (publication.rowCount) throw new Error("BROWSER_V2_CAPTURE_ALREADY_PUBLISHED");
      await client.query(
        "UPDATE browser_captures SET state='deleted',deleted_at=now(),structural_index='[]'::jsonb,encrypted_payload=NULL,encrypted_payload_digest=NULL WHERE id=$1",
        [input.captureId],
      );
      if (effect.publication_state !== "published") {
        await client.query(
          "UPDATE browser_effects SET publication_state='discarded',updated_at=now() WHERE id=$1",
          [input.effectId],
        );
      }
      await this.appendEffectEvent(client, input.effectId, effect.session_id, "discarded", {
        captureId: input.captureId,
      });
      return effect;
    });
  }

  async assertCaptureSlotAvailable(effectId: string, sessionId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(
      "SELECT id FROM browser_captures WHERE effect_id=$1 AND session_id=$2 AND state='durable' ORDER BY captured_at LIMIT 1",
      [effectId, sessionId],
    );
    if (result.rows[0]) throw new Error(`BROWSER_V2_CAPTURE_UNSETTLED:${result.rows[0].id}`);
  }

  async unsettledCaptureIds(sessionId: string): Promise<string[]> {
    return (
      await this.database.query<{ id: string }>(
        "SELECT id FROM browser_captures WHERE session_id=$1 AND state='durable' ORDER BY captured_at",
        [sessionId],
      )
    ).rows.map(({ id }) => id);
  }

  async observeEffect(effectId: string): Promise<EffectRow> {
    const result = await this.database.query<EffectRow>(
      "SELECT * FROM browser_effects WHERE id=$1",
      [effectId],
    );
    return required(result.rows[0], "BROWSER_V2_EFFECT_NOT_FOUND");
  }

  async recoverEffect(effectId: string): Promise<Record<string, unknown>> {
    const effect = await this.observeEffect(effectId);
    const captures = await this.database.query<{
      id: string;
      content_class: "http_json" | "http_text" | "http_empty" | "http_binary" | "dom_region";
      byte_size: number;
      state: "durable" | "published" | "expired" | "corrupt" | "deleted";
      structural_index: unknown[];
      captured_at: Date;
      expires_at: Date;
    }>(
      `SELECT id,content_class,byte_size,state,structural_index,captured_at,expires_at
       FROM browser_captures WHERE effect_id=$1 ORDER BY (content_class='dom_region'),captured_at,id`,
      [effectId],
    );
    const outputs = await this.database.query<{
      canonical_name: string;
      classification: "public" | "protected";
      public_value: unknown;
      protected_value_id: string | null;
    }>(
      `SELECT canonical_name,classification,public_value,protected_value_id
       FROM browser_outputs WHERE effect_id=$1 ORDER BY canonical_name`,
      [effectId],
    );
    const publicOutputs: Record<string, unknown> = {};
    const protectedReferences: Record<string, string> = {};
    for (const output of outputs.rows) {
      if (output.classification === "public")
        publicOutputs[output.canonical_name] = output.public_value;
      else if (output.protected_value_id)
        protectedReferences[output.canonical_name] = output.protected_value_id;
    }
    const receipts = captures.rows.map((capture) => ({
      captureId: capture.id,
      runId: effect.run_id,
      effectId,
      phase:
        capture.state === "durable"
          ? "captured"
          : capture.state === "deleted"
            ? "discarded"
            : capture.state,
      status: effect.response_status ?? 200,
      contentType:
        capture.content_class === "dom_region"
          ? "application/vnd.scry.dom+json"
          : capture.content_class === "http_json"
            ? "application/json"
            : "text/plain",
      bodyBytes: capture.byte_size,
      capturedAt: capture.captured_at.toISOString(),
      expiresAt: capture.expires_at.toISOString(),
      structuralIndex: capture.state === "durable" ? capture.structural_index : [],
    }));
    return {
      truth: effect,
      captures: receipts,
      ...(receipts[0] ? { capture: receipts[0] } : {}),
      ...(Object.keys(publicOutputs).length ? { publicOutputs } : {}),
      ...(Object.keys(protectedReferences).length ? { protectedReferences } : {}),
    };
  }

  async pendingSessions(
    limit = 100,
  ): Promise<Array<{ sessionId: string; runtimeCapabilityVersion: string }>> {
    const result = await this.database.query<{
      sessionId: string;
      runtimeCapabilityVersion: string;
    }>(
      `SELECT session_id AS "sessionId",runtime_capability_version AS "runtimeCapabilityVersion"
       FROM browser_execution_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async markSessionPublished(sessionId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_execution_outbox SET published_at=now(),publish_attempts=publish_attempts+1,last_error=NULL
       WHERE session_id=$1 AND published_at IS NULL`,
      [sessionId],
    );
    if (result.rowCount !== 1) {
      const existing = await this.database.query(
        "SELECT 1 FROM browser_execution_outbox WHERE session_id=$1 AND published_at IS NOT NULL",
        [sessionId],
      );
      if (existing.rowCount !== 1) throw new Error("BROWSER_V2_OUTBOX_NOT_FOUND");
    }
  }

  async markSessionPublishFailed(sessionId: string, errorCode: string): Promise<void> {
    await this.database.query(
      "UPDATE browser_execution_outbox SET publish_attempts=publish_attempts+1,last_error=$2 WHERE session_id=$1 AND published_at IS NULL",
      [sessionId, errorCode.slice(0, 500)],
    );
  }

  async finalizeSession(sessionId: string, ownerGeneration: number): Promise<void> {
    return this.finalizeSessionState(sessionId, ownerGeneration, false);
  }

  async finalizeFailedSession(sessionId: string, ownerGeneration: number): Promise<void> {
    return this.finalizeSessionState(sessionId, ownerGeneration, true);
  }

  private async finalizeSessionState(
    sessionId: string,
    ownerGeneration: number,
    allowUnknown: boolean,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId);
      if (Number(session.active_owner_generation) !== ownerGeneration)
        throw new Error("BROWSER_V2_OWNER_FENCED");
      const incomplete = await client.query<{ id: string }>(
        `SELECT e.id FROM browser_effects e WHERE e.session_id=$1 AND (
           e.mutation_outcome='pending' OR
           (NOT $2::boolean AND e.mutation_outcome='unknown') OR
           (e.mutation_outcome='applied' AND EXISTS (
             SELECT 1 FROM browser_captures c WHERE c.effect_id=e.id AND c.state='durable'
           ))) LIMIT 1`,
        [sessionId, allowUnknown],
      );
      if (incomplete.rows[0])
        throw new Error(`BROWSER_V2_SESSION_INCOMPLETE:${incomplete.rows[0].id}`);
      const evidence = await client.query<{ state: string }>(
        "SELECT state FROM browser_evidence_streams WHERE session_id=$1 FOR UPDATE",
        [sessionId],
      );
      if (evidence.rows[0]?.state !== "complete") throw new Error("BROWSER_V2_EVIDENCE_INCOMPLETE");
      await client.query(
        `UPDATE browser_owner_generations SET state='released',terminal_at=now(),replacement_reason='session_finalized'
         WHERE session_id=$1 AND generation=$2 AND state='active'`,
        [sessionId, ownerGeneration],
      );
      await client.query(
        "UPDATE browser_execution_sessions SET state='completed',terminal_at=now(),updated_at=now() WHERE id=$1",
        [sessionId],
      );
    });
  }

  private async transition<T>(
    effectId: string,
    ownerGeneration: number,
    work: (client: PoolClient, effect: EffectRow) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      const effect = await this.lockEffect(client, effectId);
      await this.assertOwner(client, effect.session_id, ownerGeneration);
      return work(client, effect);
    });
  }

  private async lockSession(client: PoolClient, sessionId: string): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      "SELECT * FROM browser_execution_sessions WHERE id=$1 FOR UPDATE",
      [sessionId],
    );
    return required(result.rows[0], "BROWSER_V2_SESSION_NOT_FOUND");
  }

  private async lockOwnedSession(
    client: PoolClient,
    sessionId: string,
    generation: number,
  ): Promise<SessionRow> {
    const session = await this.lockSession(client, sessionId);
    await this.assertOwner(client, sessionId, generation);
    return session;
  }

  private async assertOwner(
    client: PoolClient,
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const owner = await client.query<{ generation: string }>(
      `SELECT generation FROM browser_owner_generations
       WHERE session_id=$1 AND generation=$2 AND state='active' AND lease_expires_at>now() FOR UPDATE`,
      [sessionId, generation],
    );
    if (!owner.rows[0]) throw new Error("BROWSER_V2_OWNER_FENCED");
  }

  private async lockEffect(client: PoolClient, effectId: string): Promise<EffectRow> {
    const result = await client.query<EffectRow>(
      "SELECT * FROM browser_effects WHERE id=$1 FOR UPDATE",
      [effectId],
    );
    return required(result.rows[0], "BROWSER_V2_EFFECT_NOT_FOUND");
  }

  private async appendEffectEvent(
    client: PoolClient,
    effectId: string,
    sessionId: string,
    type: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const sequence = await client.query<{ next: string }>(
      "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM browser_effect_events WHERE effect_id=$1",
      [effectId],
    );
    await client.query(
      "INSERT INTO browser_effect_events(effect_id,session_id,sequence,type,safe_details) VALUES($1,$2,$3,$4,$5::jsonb)",
      [
        effectId,
        sessionId,
        required(sequence.rows[0], "BROWSER_V2_EVENT_SEQUENCE_FAILED").next,
        type,
        JSON.stringify(details),
      ],
    );
  }

  private async protectedReferences(
    client: PoolClient,
    effectId: string,
  ): Promise<Record<string, string>> {
    const result = await client.query<{ canonical_name: string; protected_value_id: string }>(
      "SELECT canonical_name,protected_value_id FROM browser_outputs WHERE effect_id=$1 AND classification='protected'",
      [effectId],
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.canonical_name, row.protected_value_id]),
    );
  }
}

function digestOutputValue(value: string | number | boolean | null): string {
  return createHash("sha256")
    .update(value === null ? "null" : String(value))
    .digest("hex");
}

function matchesEffect(effect: EffectRow, input: AdmitBrowserEffectInput): boolean {
  return (
    effect.effect_class === input.effectClass &&
    effect.expected_origin === input.expectedOrigin &&
    effect.target_digest === input.targetDigest &&
    effect.action_digest === input.actionDigest &&
    effect.intent_summary === input.intentSummary
  );
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

export function digestBrowserValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
