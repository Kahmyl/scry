import { ChronicleRepository, type CaptureEvidenceInput } from "@scry/chronicle";
import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  BrowserProtectionDecision,
  EvidenceCompletion,
  PraxisOwnerIdentity,
} from "@scry/contracts";
import {
  assertPublicationDecisionSet,
  assertPublicationDisclosure,
  storedBrowserFailureCode,
} from "@scry/veil";
import type { PoolClient, QueryResultRow } from "pg";

import { Database } from "../../infrastructure/database.js";
import { BrowserProtectedValueCipher } from "../protected-value-cipher.js";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "../browser-runtime-capability.js";
import { assertBrowserSchema } from "../browser-schema.js";

const CAPABILITY_ID = BROWSER_RUNTIME_CAPABILITY_ID;

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
  runtime_capability_id: string;
  protection_key_id: string;
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

  async withOwner<T>(owner: PraxisOwnerIdentity, work: () => Promise<T>): Promise<T> {
    return this.ownedTransaction(owner, async () => work());
  }

  async completeEvidence(owner: PraxisOwnerIdentity, input: EvidenceCompletion): Promise<void> {
    await this.ownedTransaction(owner, async (client, session) => {
      if (input.sessionId !== owner.sessionId || input.runId !== session.run_id)
        throw new Error("SCRY_BROWSER_EVIDENCE_SCOPE_MISMATCH");
      await new ChronicleRepository(client).completeEvidence(input);
    });
  }

  private async ownedTransaction<T>(
    owner: PraxisOwnerIdentity,
    work: (client: PoolClient, session: SessionRow) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, owner.sessionId);
      if (session.state !== "active") throw new Error("SCRY_BROWSER_SESSION_NOT_ACTIVE");
      if (Number(session.active_owner_generation) !== owner.generation)
        throw new Error("SCRY_BROWSER_OWNER_FENCED");
      const admitted = await client.query(
        `SELECT 1 FROM browser_owner_generations WHERE session_id=$1 AND generation=$2
         AND lease_token=$3 AND state='active' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
        [owner.sessionId, owner.generation, owner.leaseToken],
      );
      if (admitted.rowCount !== 1) throw new Error("SCRY_BROWSER_OWNER_FENCED");
      return work(client, session);
    });
  }

  async assertCompatibleBaseline(): Promise<void> {
    await assertBrowserSchema(this.database.pool);
    const result = await this.database.query<{ runtime_capability_id: string }>(
      "SELECT runtime_capability_id FROM schema_baseline WHERE singleton=true",
    );
    const row = result.rows[0];
    if (!row || row.runtime_capability_id !== CAPABILITY_ID) {
      throw new Error("SCRY_BROWSER_SCHEMA_CAPABILITY_MISMATCH");
    }
    if (process.env.SCRY_BROWSER_REQUIRE_ACTIVATED_CUTOVER === "true") {
      const activation = await this.database.query(
        "SELECT 1 FROM identity_import_receipts WHERE mode='permanent' AND state='active' LIMIT 1",
      );
      if (!activation.rowCount) throw new Error("SCRY_BROWSER_CUTOVER_NOT_ACTIVATED");
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
      throw new Error("SCRY_BROWSER_EFFECT_IDEMPOTENCY_CONFLICT");
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
          throw new Error("SCRY_BROWSER_SESSION_IDEMPOTENCY_CONFLICT");
        }
        return row;
      }
      const environment = await client.query<{ disclosure_mode: string }>(
        "SELECT disclosure_mode FROM environments WHERE id=$1 AND project_id=$2",
        [input.environmentId, input.projectId],
      );
      if (!environment.rows[0]) throw new Error("SCRY_BROWSER_ENVIRONMENT_NOT_FOUND");
      const inserted = await client.query<SessionRow>(
        `INSERT INTO browser_execution_sessions(
           id,run_id,project_id,mission_id,objective_id,environment_id,agent_session_id,
           authentication_commit_limit,business_commit_limit,allowed_first_party_origins,
           allowed_service_origins,runtime_capability_id,protection_key_id,
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
          CAPABILITY_ID,
          this.cipher.activeKeyId(),
          environment.rows[0].disclosure_mode,
          input.idempotencyKey,
        ],
      );
      await client.query(
        "INSERT INTO browser_execution_outbox(session_id,runtime_capability_id) VALUES($1,$2)",
        [input.id, CAPABILITY_ID],
      );
      return required(inserted.rows[0], "SCRY_BROWSER_SESSION_INSERT_FAILED");
    });
  }

  async claimOwner(
    sessionId: string,
    workerId: string,
    leaseMs: number,
    reason = "claim",
  ): Promise<{ generation: number; leaseToken: string; fencingToken: number }> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000)
      throw new Error("SCRY_BROWSER_OWNER_LEASE_INVALID");
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId);
      if (session.state !== "active") throw new Error("SCRY_BROWSER_SESSION_NOT_ACTIVE");
      const now = new Date();
      const active = await client.query<{ generation: number; lease_expires_at: Date }>(
        "SELECT generation,lease_expires_at FROM browser_owner_generations WHERE session_id=$1 AND state='active' FOR UPDATE",
        [sessionId],
      );
      if (active.rows[0] && new Date(active.rows[0].lease_expires_at).getTime() > now.getTime()) {
        throw new Error("SCRY_BROWSER_OWNER_ACTIVE");
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
           runtime_capability_id)
         VALUES($1,$2,$3,$4,$2,'active',$5,$6)`,
        [
          sessionId,
          generation,
          workerId,
          leaseToken,
          new Date(now.getTime() + leaseMs),
          CAPABILITY_ID,
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
    if (result.rowCount !== 1) throw new Error("SCRY_BROWSER_OWNER_FENCED");
  }

  async releaseOwner(sessionId: string, generation: number, leaseToken: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE browser_owner_generations SET state='released',terminal_at=now(),replacement_reason='session_closed'
       WHERE session_id=$1 AND generation=$2 AND lease_token=$3 AND state='active'`,
      [sessionId, generation, leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("SCRY_BROWSER_OWNER_FENCED");
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
        `SCRY_BROWSER_EFFECT_OUTCOME_PENDING:${pending.rows.map(({ id }) => id).join(",")}`,
      );
    }
  }

  async prepareFailureFinalization(sessionId: string, ownerGeneration: number): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.lockOwnedSession(client, sessionId, ownerGeneration);
      const unsettled = await new ChronicleRepository(client).lockUnsettledCaptures(sessionId);
      if (unsettled.rows.length > 0) {
        throw new Error(
          `SCRY_BROWSER_CAPTURES_UNSETTLED:${unsettled.rows.map(({ id }) => id).join(",")}`,
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
          throw new Error("SCRY_BROWSER_EFFECT_IDEMPOTENCY_CONFLICT");
        return { replay: true, effect };
      }
      const unresolved = await client.query<{ id: string }>(
        `SELECT id FROM browser_effects
         WHERE session_id=$1 AND effect_class=$2 AND mutation_outcome IN ('pending','unknown')
         LIMIT 1 FOR UPDATE`,
        [input.sessionId, input.effectClass],
      );
      if (unresolved.rows[0])
        throw new Error(`SCRY_BROWSER_EFFECT_UNRESOLVED:${unresolved.rows[0].id}`);

      const limit =
        input.effectClass === "authentication"
          ? session.authentication_commit_limit
          : session.business_commit_limit;
      const used =
        input.effectClass === "authentication"
          ? session.authentication_commits_used
          : session.business_commits_used;
      if (used >= limit)
        throw new Error(`SCRY_BROWSER_${input.effectClass.toUpperCase()}_BUDGET_EXHAUSTED`);
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
          required(ordinal.rows[0], "SCRY_BROWSER_EFFECT_ORDINAL_FAILED").next,
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
        effect: required(inserted.rows[0], "SCRY_BROWSER_EFFECT_INSERT_FAILED"),
      };
    });
  }

  async markDispatchStarted(effectId: string, ownerGeneration: number): Promise<EffectRow> {
    return this.transition(effectId, ownerGeneration, async (client, effect) => {
      if (effect.dispatch_state === "started") return effect;
      if (effect.dispatch_state !== "not_started" || effect.mutation_outcome !== "pending")
        throw new Error("SCRY_BROWSER_DISPATCH_TRANSITION_INVALID");
      const updated = await client.query<EffectRow>(
        "UPDATE browser_effects SET dispatch_state='started',dispatch_started_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [effectId],
      );
      await this.appendEffectEvent(client, effectId, effect.session_id, "dispatch_started", {});
      return required(updated.rows[0], "SCRY_BROWSER_EFFECT_UPDATE_FAILED");
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
        throw new Error("SCRY_BROWSER_OUTCOME_UNPROVEN");
      if (outcome === "not_applied" && ["started", "unknown"].includes(effect.dispatch_state))
        throw new Error("SCRY_BROWSER_NOT_APPLIED_UNPROVEN");
      if (outcome === "applied" && effect.dispatch_state !== "acknowledged")
        throw new Error("SCRY_BROWSER_APPLIED_UNPROVEN");
      if (effect.mutation_outcome !== "pending" && effect.mutation_outcome !== "unknown")
        throw new Error("SCRY_BROWSER_EFFECT_ALREADY_TERMINAL");
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
      return required(updated.rows[0], "SCRY_BROWSER_EFFECT_UPDATE_FAILED");
    });
  }

  async registerCapture(input: CaptureEvidenceInput): Promise<void> {
    await this.transition(input.effectId, input.ownerGeneration, async (client, effect) => {
      new ChronicleRepository(client).validateCaptureEnvelope(input);
      const ownsHttpResponse = input.responseStatus !== undefined;
      if (ownsHttpResponse) {
        if (
          !Number.isInteger(input.responseStatus) ||
          input.responseStatus! < 100 ||
          input.responseStatus! > 599 ||
          !["started", "unknown", "acknowledged"].includes(effect.dispatch_state)
        )
          throw new Error("SCRY_BROWSER_RESPONSE_TRANSITION_INVALID");
        if (
          effect.dispatch_state === "acknowledged" &&
          effect.response_status !== input.responseStatus
        )
          throw new Error("SCRY_BROWSER_RESPONSE_CONFLICT");
      } else if (effect.dispatch_state !== "acknowledged") {
        throw new Error("SCRY_BROWSER_CAPTURE_BEFORE_RESPONSE");
      }
      if (!(await new ChronicleRepository(client).registerCapture(input, effect.session_id)))
        return effect;
      if (ownsHttpResponse && effect.dispatch_state !== "acknowledged") {
        await client.query(
          `UPDATE browser_effects
              SET dispatch_state='acknowledged',response_status=$2,response_observed_at=now(),
                  capture_state='durable',updated_at=now()
            WHERE id=$1`,
          [input.effectId, input.responseStatus],
        );
        await this.appendEffectEvent(
          client,
          input.effectId,
          effect.session_id,
          "response_observed",
          {
            status: input.responseStatus,
          },
        );
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
    return new ChronicleRepository(this.database).durableCapturesForSession(sessionId);
  }

  async publishOutputs(
    input: PublishBrowserOutputsInput,
  ): Promise<{ publicationId: string; protectedReferences: Record<string, string> }> {
    return this.database.transaction(async (client) => {
      const effect = await this.lockEffect(client, input.effectId);
      await this.assertOwner(client, effect.session_id, input.ownerGeneration);
      if (effect.capture_state !== "durable") throw new Error("SCRY_BROWSER_CAPTURE_NOT_DURABLE");
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
          throw new Error("SCRY_BROWSER_PUBLICATION_CONFLICT");
        return {
          publicationId: existing.rows[0].id,
          protectedReferences: await this.protectedReferences(client, effect.id),
        };
      }
      const outputCount = assertPublicationDecisionSet(input);
      const capture = await new ChronicleRepository(client).captureForPublication(
        input.captureId,
        input.effectId,
      );
      if (!capture.rows[0]) throw new Error("SCRY_BROWSER_CAPTURE_UNAVAILABLE");
      const disclosure = await client.query<{ disclosure_mode: string }>(
        "SELECT disclosure_mode FROM browser_execution_sessions WHERE id=$1",
        [effect.session_id],
      );
      assertPublicationDisclosure(
        input,
        capture.rows[0].structural_index,
        disclosure.rows[0]?.disclosure_mode,
      );
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
          outputCount,
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
             external_reference,ciphertext,nonce,authentication_tag,value_digest,key_id)
           VALUES($1,$2,$3,$4,$5,'generated',$6,$7,$8,$9,$10,$11,$12)`,
          [
            protectedValueId,
            effect.project_id,
            effect.mission_id,
            effect.run_id,
            effect.id,
            canonicalName,
            `protected://browser/${protectedValueId}`,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authenticationTag,
            encrypted.valueDigest,
            encrypted.keyId,
          ],
        );
        await client.query(
          `INSERT INTO browser_outputs(publication_id,effect_id,project_id,canonical_name,classification,protected_value_id)
           VALUES($1,$2,$3,$4,'protected',$5)`,
          [publicationId, input.effectId, effect.project_id, canonicalName, protectedValueId],
        );
        protectedReferences[canonicalName] = protectedValueId;
      }
      await new ChronicleRepository(client).settleCapture(input.captureId, "published");
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
      if (effect.capture_state !== "durable") throw new Error("SCRY_BROWSER_CAPTURE_NOT_DURABLE");
      const capture = await new ChronicleRepository(client).captureForDiscard(
        input.captureId,
        input.effectId,
      );
      const row = capture.rows[0];
      if (!row) throw new Error("SCRY_BROWSER_CAPTURE_UNAVAILABLE");
      if (row.state === "deleted") return effect;
      if (row.state !== "durable") throw new Error("SCRY_BROWSER_CAPTURE_ALREADY_SETTLED");
      const publication = await client.query(
        "SELECT 1 FROM browser_publications WHERE capture_id=$1",
        [input.captureId],
      );
      if (publication.rowCount) throw new Error("SCRY_BROWSER_CAPTURE_ALREADY_PUBLISHED");
      await new ChronicleRepository(client).settleCapture(input.captureId, "deleted");
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
    return new ChronicleRepository(this.database).assertCaptureSlotAvailable(effectId, sessionId);
  }

  async unsettledCaptureIds(sessionId: string): Promise<string[]> {
    return new ChronicleRepository(this.database).unsettledCaptureIds(sessionId);
  }

  async observeEffect(effectId: string): Promise<EffectRow> {
    const result = await this.database.query<EffectRow>(
      "SELECT * FROM browser_effects WHERE id=$1",
      [effectId],
    );
    return required(result.rows[0], "SCRY_BROWSER_EFFECT_NOT_FOUND");
  }

  async recoverEffect(effectId: string): Promise<Record<string, unknown>> {
    return new ChronicleRepository(this.database).recoverEffect(
      effectId,
      await this.observeEffect(effectId),
    );
  }

  async pendingSessions(
    limit = 100,
  ): Promise<Array<{ sessionId: string; runtimeCapabilityId: string }>> {
    const result = await this.database.query<{
      sessionId: string;
      runtimeCapabilityId: string;
    }>(
      `SELECT session_id AS "sessionId",runtime_capability_id AS "runtimeCapabilityId"
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
      if (existing.rowCount !== 1) throw new Error("SCRY_BROWSER_OUTBOX_NOT_FOUND");
    }
  }

  async markSessionPublishFailed(sessionId: string, errorCode: string): Promise<void> {
    await this.database.query(
      "UPDATE browser_execution_outbox SET publish_attempts=publish_attempts+1,last_error=$2 WHERE session_id=$1 AND published_at IS NULL",
      [sessionId, storedBrowserFailureCode(errorCode)],
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
        throw new Error("SCRY_BROWSER_OWNER_FENCED");
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
        throw new Error(`SCRY_BROWSER_SESSION_INCOMPLETE:${incomplete.rows[0].id}`);
      if (!(await new ChronicleRepository(client).evidenceComplete(sessionId, true)))
        throw new Error("SCRY_BROWSER_EVIDENCE_INCOMPLETE");
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
    return required(result.rows[0], "SCRY_BROWSER_SESSION_NOT_FOUND");
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
    if (!owner.rows[0]) throw new Error("SCRY_BROWSER_OWNER_FENCED");
  }

  private async lockEffect(client: PoolClient, effectId: string): Promise<EffectRow> {
    const result = await client.query<EffectRow>(
      "SELECT * FROM browser_effects WHERE id=$1 FOR UPDATE",
      [effectId],
    );
    return required(result.rows[0], "SCRY_BROWSER_EFFECT_NOT_FOUND");
  }

  private async appendEffectEvent(
    client: PoolClient,
    effectId: string,
    sessionId: string,
    type: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    return new ChronicleRepository(client).appendEffectEvent(effectId, sessionId, type, details);
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
