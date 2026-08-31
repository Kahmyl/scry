import { createHash, randomUUID } from "node:crypto";

import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  operationContractFactsSchema,
  operationContractRegistryEntrySchema,
  proposedOperationContractSchema,
  type OperationContractRegistryEntry,
  type PraxisObservation,
  type ProposedOperationContract,
} from "@scry/contracts";

import { Database } from "../infrastructure/index.js";

/** Adapters propose semantics from evidence; the registry alone admits durable authority. */
export interface OperationContractAdapter {
  project(praxisSessionId: string, observation: PraxisObservation): ProposedOperationContract[];
}

export const OPERATION_CONTRACT_ADAPTERS = Symbol("OPERATION_CONTRACT_ADAPTERS");

@Injectable()
export class OperationContractProviderRegistry {
  constructor(
    @Inject(OPERATION_CONTRACT_ADAPTERS)
    private readonly adapters: readonly OperationContractAdapter[],
  ) {}

  project(
    praxisSessionId: string,
    observation: PraxisObservation,
    generic: ProposedOperationContract[],
  ) {
    const proposed = [
      ...generic,
      ...this.adapters.flatMap((adapter) => adapter.project(praxisSessionId, observation)),
    ];
    const byIdentity = new Map<string, ProposedOperationContract>();
    for (const candidate of proposed.map((value) => proposedOperationContractSchema.parse(value))) {
      const identity = `${candidate.facts.application.key}:${candidate.facts.operation.key}`;
      const existing = byIdentity.get(identity);
      if (
        existing &&
        (semanticDigest(existing) !== semanticDigest(candidate) ||
          stableJson(existing.interaction) !== stableJson(candidate.interaction))
      )
        throw new ConflictException({ code: "OPERATION_CONTRACT_PROVIDER_CONFLICT", identity });
      byIdentity.set(identity, candidate);
    }
    return [...byIdentity.values()];
  }
}

@Injectable()
export class OperationContractRegistry {
  constructor(@Inject(Database) private readonly database: Database) {}

  async register(
    praxisSessionId: string,
    proposals: ProposedOperationContract[],
  ): Promise<OperationContractRegistryEntry[]> {
    if (!proposals.length) return [];
    const identities = new Map<string, string>();
    for (const proposal of proposals) {
      const key = `${proposal.facts.application.key}:${proposal.facts.operation.key}`;
      const commitment = stableJson({ facts: proposal.facts, interaction: proposal.interaction });
      if (identities.has(key) && identities.get(key) !== commitment)
        throw new ConflictException({
          code: "OPERATION_CONTRACT_PROVIDER_CONFLICT",
          identity: key,
        });
      identities.set(key, commitment);
    }
    return this.database.transaction(async (client) => {
      const authority = await client.query<{
        projectId: string;
        missionId: string;
        ownerId: string;
        fencingEpoch: number;
        leaseExpiresAt: string;
      }>(
        `SELECT session.project_id AS "projectId",session.mission_id AS "missionId",lease.owner_id AS "ownerId",
                lease.fencing_token AS "fencingEpoch",lease.lease_expires_at AS "leaseExpiresAt"
           FROM adaptive_sessions session
           JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
          WHERE session.id=$1 AND session.state IN ('active','suspended')
            AND lease.lease_expires_at>now() FOR SHARE OF session,lease`,
        [praxisSessionId],
      );
      const runtime = authority.rows[0];
      if (!runtime)
        throw new ConflictException({ code: "RUNTIME_INTERACTION_AUTHORITY_UNAVAILABLE" });

      const entries: OperationContractRegistryEntry[] = [];
      for (const raw of [...proposals].sort((left, right) =>
        `${left.facts.application.key}:${left.facts.operation.key}`.localeCompare(
          `${right.facts.application.key}:${right.facts.operation.key}`,
        ),
      )) {
        const proposal = proposedOperationContractSchema.parse(raw);
        if (proposal.interaction.praxisSessionId !== praxisSessionId)
          throw new ConflictException({ code: "OPERATION_CONTRACT_PRAXIS_SCOPE_MISMATCH" });
        const facts = operationContractFactsSchema.parse(proposal.facts);
        // Serialize revision admission for the same semantic identity, including
        // the first revision (there is no existing row to lock yet).
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `operation-contract:${runtime.projectId}:${facts.application.key}:${facts.operation.key}`,
        ]);
        const digest = semanticDigest(proposal);
        const existing = await client.query<{
          id: string;
          revision: number;
          createdAt: string;
          retentionState: "active" | "superseded" | "retained" | "expired";
          staleness: "current" | "historical" | "unknown";
          provenance: ProposedOperationContract["provenance"];
        }>(
          `SELECT id,revision,created_at AS "createdAt",retention_state AS "retentionState",
                  staleness,provenance
             FROM operation_contract_revisions
            WHERE project_id=$1 AND semantic_digest=$2`,
          [runtime.projectId, digest],
        );
        let revision = existing.rows[0];
        if (revision && (revision.retentionState !== "active" || revision.staleness !== "current"))
          throw new ConflictException({ code: "OPERATION_CONTRACT_REVISION_STALE" });
        if (!revision) {
          await client.query(
            `UPDATE operation_contract_revisions
                SET retention_state='superseded',staleness='historical'
              WHERE project_id=$1 AND application_key=$2 AND operation_key=$3
                AND semantic_digest<>$4 AND retention_state='active'`,
            [runtime.projectId, facts.application.key, facts.operation.key, digest],
          );
          await client.query(
            `UPDATE runtime_interaction_capabilities SET state='stale',revoked_at=now()
              WHERE state='active' AND operation_contract_revision_id IN (
                SELECT id FROM operation_contract_revisions
                 WHERE project_id=$1 AND application_key=$2 AND operation_key=$3
                   AND semantic_digest<>$4
              )`,
            [runtime.projectId, facts.application.key, facts.operation.key, digest],
          );
          const inserted = await client.query<(typeof existing.rows)[number]>(
            `INSERT INTO operation_contract_revisions(
               project_id,application_key,provider_key,adapter_key,adapter_version,
               operation_key,revision,facts,provenance,semantic_digest
             ) VALUES($1,$2,$3,$4,$5,$6,
               COALESCE((SELECT max(candidate.revision)+1 FROM operation_contract_revisions candidate
                 WHERE candidate.project_id=$1 AND candidate.application_key=$2
                   AND candidate.operation_key=$6),1),$7::jsonb,$8::jsonb,$9)
             RETURNING id,revision,created_at AS "createdAt",
               retention_state AS "retentionState",staleness,provenance`,
            [
              runtime.projectId,
              facts.application.key,
              facts.application.provider ?? null,
              facts.adapter.key,
              facts.adapter.version,
              facts.operation.key,
              JSON.stringify(facts),
              JSON.stringify(proposal.provenance),
              digest,
            ],
          );
          revision = inserted.rows[0]!;
        }
        await client.query(
          `INSERT INTO operation_contract_observations(
             operation_contract_revision_id,praxis_session_id,mission_id,observation_provenance
           ) VALUES($1,$2,$3,$4::jsonb)
           ON CONFLICT(operation_contract_revision_id,praxis_session_id) DO NOTHING`,
          [revision.id, praxisSessionId, runtime.missionId, JSON.stringify(proposal.provenance)],
        );
        await client.query(
          `UPDATE runtime_interaction_capabilities SET state='stale',revoked_at=now()
            WHERE praxis_session_id=$1 AND operation_contract_revision_id=$2 AND state='active'
              AND (runtime_owner_id<>$3 OR fencing_epoch<>$4 OR document_epoch<>$5
                OR origin<>$6 OR activation_control_reference<>$7 OR input_control_references<>$8::jsonb)`,
          [
            praxisSessionId,
            revision.id,
            runtime.ownerId,
            runtime.fencingEpoch,
            proposal.interaction.documentEpoch,
            proposal.interaction.origin,
            proposal.interaction.activationControlReference,
            JSON.stringify(proposal.interaction.inputControlReferences),
          ],
        );
        const interaction = await client.query<{
          id: string;
          issuedAt: string;
          expiresAt: string;
        }>(
          `WITH existing AS (
             SELECT id,issued_at AS "issuedAt",expires_at AS "expiresAt"
               FROM runtime_interaction_capabilities
              WHERE operation_contract_revision_id=$2 AND operation_contract_revision_digest=$3
                AND praxis_session_id=$4 AND runtime_owner_id=$5 AND fencing_epoch=$6
                AND document_epoch=$7 AND origin=$8 AND activation_control_reference=$9
                AND input_control_references=$10::jsonb AND state='active' AND expires_at>now()
              ORDER BY issued_at DESC LIMIT 1
           ), inserted AS (
             INSERT INTO runtime_interaction_capabilities(
               id,operation_contract_revision_id,operation_contract_revision_digest,praxis_session_id,
               runtime_owner_id,fencing_epoch,document_epoch,origin,activation_control_reference,
               input_control_references,expires_at
             ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11
              WHERE NOT EXISTS(SELECT 1 FROM existing)
             RETURNING id,issued_at AS "issuedAt",expires_at AS "expiresAt"
           ) SELECT * FROM existing UNION ALL SELECT * FROM inserted`,
          [
            randomUUID(),
            revision.id,
            digest,
            praxisSessionId,
            runtime.ownerId,
            runtime.fencingEpoch,
            proposal.interaction.documentEpoch,
            proposal.interaction.origin,
            proposal.interaction.activationControlReference,
            JSON.stringify(proposal.interaction.inputControlReferences),
            runtime.leaseExpiresAt,
          ],
        );
        entries.push(
          operationContractRegistryEntrySchema.parse({
            revision: {
              id: revision.id,
              revision: revision.revision,
              digest,
              facts,
              provenance: revision.provenance,
              retentionState: revision.retentionState,
              staleness: revision.staleness,
              createdAt: new Date(revision.createdAt).toISOString(),
            },
            interaction: {
              id: interaction.rows[0]!.id,
              operationContractRevisionId: revision.id,
              operationContractRevisionDigest: digest,
              praxisSessionId,
              runtimeOwnerId: runtime.ownerId,
              fencingEpoch: runtime.fencingEpoch,
              documentEpoch: proposal.interaction.documentEpoch,
              origin: proposal.interaction.origin,
              activationControlReference: proposal.interaction.activationControlReference,
              inputControlReferences: proposal.interaction.inputControlReferences,
              issuedAt: new Date(interaction.rows[0]!.issuedAt).toISOString(),
              expiresAt: new Date(interaction.rows[0]!.expiresAt).toISOString(),
              state: "active",
            },
            executableInteractionAvailable: true,
          }),
        );
      }
      return entries;
    });
  }

  async readDurable(praxisSessionId: string): Promise<OperationContractRegistryEntry[]> {
    const result = await this.database.query<{
      id: string;
      revision: number;
      digest: string;
      facts: unknown;
      provenance: unknown;
      retentionState: "active" | "superseded" | "retained" | "expired";
      staleness: "current" | "historical" | "unknown";
      createdAt: string;
    }>(
      `SELECT revision.id,revision.revision,revision.semantic_digest AS digest,revision.facts,
              revision.provenance,revision.retention_state AS "retentionState",revision.staleness,
              revision.created_at AS "createdAt"
         FROM adaptive_sessions session
         JOIN operation_contract_revisions revision
           ON revision.project_id=session.project_id
        WHERE session.id=$1 AND EXISTS(
          SELECT 1 FROM operation_contract_observations observation
           WHERE observation.operation_contract_revision_id=revision.id
             AND observation.mission_id=session.mission_id)
        ORDER BY revision.application_key,revision.operation_key,revision.revision DESC`,
      [praxisSessionId],
    );
    return result.rows.map((row) =>
      operationContractRegistryEntrySchema.parse({
        revision: {
          id: row.id,
          revision: row.revision,
          digest: row.digest,
          facts: row.facts,
          provenance: row.provenance,
          retentionState: row.retentionState,
          staleness: row.staleness,
          createdAt: new Date(row.createdAt).toISOString(),
        },
        executableInteractionAvailable: false,
      }),
    );
  }
}

function semanticDigest(proposal: ProposedOperationContract) {
  return createHash("sha256").update(stableJson(proposal.facts)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
