import { randomUUID } from "node:crypto";

import type { ProtectedOperationState } from "@scry/contracts";
import type {
  ProtectedOperationClaim,
  ProtectedTransactionStore,
} from "@scry/executor";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";

export type CertificationSemantics = "one_time" | "read_only";
export type CertificationOutputManifest = Array<{
  reference: string;
  classification: "public" | "protected";
  storageName: string;
}>;

export class ProtectedCertificationDatabase {
  readonly database: Database;
  readonly operations: ProtectedOperationRepository;
  readonly outputs: ProtectedOutputPersistenceRepository;
  readonly sessions: AdaptiveSessionRepository;
  readonly leaseOwner = `certification-owner-${randomUUID()}`;
  readonly workspaceId = randomUUID();
  readonly projectId = randomUUID();
  readonly environmentId = randomUUID();
  readonly missionId = randomUUID();
  readonly objectiveId = randomUUID();
  readonly agentSessionId = randomUUID();
  readonly flowDraftId = randomUUID();
  readonly authorizationId = randomUUID();
  sessionId = "";

  private constructor(databaseUrl: string) {
    process.env.DATABASE_URL = databaseUrl;
    this.database = new Database();
    this.operations = new ProtectedOperationRepository(this.database);
    this.outputs = new ProtectedOutputPersistenceRepository(this.database);
    this.sessions = new AdaptiveSessionRepository(this.database);
  }

  static async create(databaseUrl = certificationDatabaseUrl()) {
    const fixture = new ProtectedCertificationDatabase(databaseUrl);
    await fixture.initialize();
    return fixture;
  }

  async close() {
    await this.database.query(`DELETE FROM workspaces WHERE id=$1`, [this.workspaceId]).catch(() => undefined);
    await this.database.onModuleDestroy();
  }

  async createOperation(operationId: string, semantics: CertificationSemantics, manifest = outputManifest()) {
    return this.operations.create({
      ownerKind: "authoring_session", ownerId: this.sessionId, flowDraftId: this.flowDraftId,
      authorizationId: this.authorizationId, operationId, mutationIdentity: operationId,
      projectId: this.projectId, environmentId: this.environmentId, missionId: this.missionId,
      objectiveId: this.objectiveId, agentSessionId: this.agentSessionId,
      programDigest: "a".repeat(64), dispatchSemantics: semantics === "read_only" ? "read_only" : "mutation",
      safeOutputManifest: manifest,
    });
  }

  claimOperation(operationId: string, leaseOwner = this.leaseOwner, semantics: CertificationSemantics = "one_time", manifest = outputManifest(), programDigest = "a".repeat(64)) {
    return this.operations.claim({
      ownerKind: "authoring_session", ownerId: this.sessionId, operationId, leaseOwner,
      leaseDurationMs: 30_000,
      binding: {
        mutationIdentity: operationId, projectId: this.projectId,
        environmentId: this.environmentId, missionId: this.missionId, objectiveId: this.objectiveId,
        agentSessionId: this.agentSessionId, programDigest, flowDraftId: this.flowDraftId,
        authorizationId: this.authorizationId, safeOutputManifest: manifest,
        dispatchSemantics: semantics === "read_only" ? "read_only" : "mutation",
      },
    });
  }

  async moveTo(claim: ProtectedOperationClaim, target: ProtectedOperationState, leaseOwner = this.leaseOwner) {
    const path: ProtectedOperationState[] = [
      "planned", "preparing", "ready_to_dispatch", "dispatching", "dispatched",
      "acquiring", "persisting", "persisted", "reconciling", "completed",
    ];
    let current = claim;
    for (const next of path.slice(path.indexOf(current.state) + 1, path.indexOf(target) + 1)) {
      current = await this.operations.transition({
        id: current.id, leaseOwner, fencingToken: current.fencingToken, version: current.version,
        expected: current.state, next, phase: next,
      });
    }
    return current;
  }

  store(semantics: CertificationSemantics, manifest = outputManifest(), programDigest = "a".repeat(64)): ProtectedTransactionStore {
    let current: ProtectedOperationClaim | undefined;
    return {
      claim: async (input) => {
        try {
          await this.createOperation(input.operationId, semantics, manifest);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("PROTECTED_OPERATION_ALREADY_EXISTS")) throw error;
        }
        current = await this.claimOperation(input.operationId, this.leaseOwner, semantics, manifest, programDigest);
        return current;
      },
      transition: async (input) => {
        current = await this.operations.transition({ ...input, leaseOwner: this.leaseOwner });
        return current;
      },
      record: async (input) => {
        if (!current) throw new Error("PROTECTED_OPERATION_NOT_CLAIMED");
        await this.operations.record({ id: current.id, leaseOwner: this.leaseOwner,
          fencingToken: input.fencingToken, phase: input.phase, safeDiagnostics: input.facts ?? {}, durationMs: 0 });
      },
      heartbeat: async (claim) => this.operations.heartbeat({ id: claim.id, leaseOwner: this.leaseOwner,
        fencingToken: claim.fencingToken, leaseDurationMs: 30_000 }),
      heartbeatIntervalMs: 10_000,
    };
  }

  async observe(operationId: string) {
    const result = await this.database.query<{
      id: string;
      state: string;
      mutationOutcome: string;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
      fencingToken: number;
      references: Record<string, unknown> | null;
      dispatchCount: number;
    }>(
      `SELECT operation.id,operation.state,operation.mutation_outcome AS "mutationOutcome",
              operation.lease_owner AS "leaseOwner",operation.lease_expires_at AS "leaseExpiresAt",
              operation.fencing_token AS "fencingToken",operation.persisted_references AS references,
              (SELECT count(*)::int FROM protected_operation_transitions transition
                WHERE transition.protected_operation_id=operation.id AND transition.to_state='dispatching') AS "dispatchCount"
         FROM protected_operations operation
        WHERE operation.authoring_session_id=$1 AND operation.operation_id=$2`,
      [this.sessionId, operationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("CERTIFICATION_PROTECTED_OPERATION_MISSING");
    return row;
  }

  private async initialize() {
    await this.database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Certification',$2)`, [this.workspaceId, `cert-${this.workspaceId}`]);
    await this.database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Certification')`, [this.projectId, this.workspaceId]);
    await this.database.query(`INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'Certification','https://fixture.test',$3::jsonb)`,
      [this.environmentId, this.projectId, JSON.stringify({ allowedOrigins: ["https://fixture.test"], allowPrivateNetwork: false,
        allowDownloads: false, allowPopups: false, maxActions: 20, maxDurationMs: 30_000, maxNavigations: 10 })]);
    await this.database.query(`INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Certification','Certification')`, [this.missionId, this.projectId]);
    await this.database.query(`INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Certification','{}'::jsonb,0)`, [this.objectiveId, this.missionId]);
    await this.database.query(`INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Certification',$3)`,
      [this.agentSessionId, this.missionId, `agent-${this.agentSessionId}`]);
    await this.database.query(`INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id)
      VALUES($1,$2,$3,$4,$5,'Certification','{}'::jsonb,'{}'::jsonb,$6)`,
      [this.flowDraftId, this.projectId, this.missionId, this.objectiveId, this.environmentId, this.agentSessionId]);
    await this.database.query(`INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id)
      VALUES($1,$2,$3,$4,'protected_mutation','Certification','approved',$5)`,
      [this.authorizationId, this.missionId, this.objectiveId, this.environmentId, this.agentSessionId]);
    const session = await this.sessions.create(this.workspaceId, {
      projectId: this.projectId, missionId: this.missionId, objectiveId: this.objectiveId,
      flowDraftId: this.flowDraftId, environmentId: this.environmentId, agentSessionId: this.agentSessionId,
      objective: "Certification", allowedOrigins: ["https://fixture.test"], idempotencyKey: `session-${randomUUID()}`,
    });
    this.sessionId = session.id;
  }
}

function outputManifest() {
  return [
    { reference: "publicValue", classification: "public" as const, storageName: "Public value" },
    { reference: "protectedValue", classification: "protected" as const, storageName: "Protected value" },
  ];
}

export function certificationDatabaseUrl() {
  return process.env.SCRY_AUTHORING_TEST_DATABASE_URL ??
    "postgres://scry:scry-local@127.0.0.1:54329/scry_protected_lifecycle_test";
}
