import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  VEIL_CONTRACT_VERSION,
  veilPreferenceRecordSchema,
  veilPreferenceUpdateSchema,
  type VeilPolicyPreferences,
  type VeilPolicySnapshot,
  type VeilPreferenceRecord,
  type VeilPreferenceUpdate,
} from "@scry/contracts";
import { compileVeilPolicy } from "@scry/policy";

import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";
import { ScryRepository } from "./repository.js";

@Injectable()
export class VeilPreferencesService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ScryRepository) private readonly repository: ScryRepository,
  ) {}

  async get(principal: Principal, environmentId: string): Promise<VeilPreferenceRecord> {
    const environment = await this.environment(principal, environmentId);
    const preferences = environment.preferences ?? defaultPreferences(environment.policy.allowedOrigins);
    const effectivePolicy = compileVeilPolicy(preferences);
    return veilPreferenceRecordSchema.parse({
      schemaVersion: VEIL_CONTRACT_VERSION,
      environmentId,
      preferences,
      effectivePolicy,
      updatedAt: new Date(environment.updatedAt ?? 0).toISOString(),
    });
  }

  async tighten(principal: Principal, environmentId: string, raw: VeilPreferenceUpdate): Promise<VeilPreferenceRecord> {
    this.repository.requireWriteAccess(principal);
    const input = veilPreferenceUpdateSchema.parse(raw);
    const current = await this.get(principal, environmentId);
    const desired: VeilPolicyPreferences = {
      profile: input.profile ?? current.preferences.profile,
      allowedOrigins: input.allowedOrigins ?? current.preferences.allowedOrigins,
      controls: { ...current.preferences.controls, ...input.controls },
      leaseTtlMs: input.leaseTtlMs ?? current.preferences.leaseTtlMs,
    };
    assertTightening(current.effectivePolicy, compileVeilPolicy(desired));
    const effectivePolicy = compileVeilPolicy([snapshotPreferences(current.effectivePolicy), desired]);
    const persisted = snapshotPreferences(effectivePolicy);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO veil_environment_preferences(environment_id,preferences,policy_digest,updated_at)
         VALUES($1,$2::jsonb,$3,now())
         ON CONFLICT(environment_id) DO UPDATE
           SET preferences=EXCLUDED.preferences,policy_digest=EXCLUDED.policy_digest,updated_at=now()`,
        [environmentId, JSON.stringify(persisted), effectivePolicy.digest],
      );
      await client.query(
        `INSERT INTO veil_preference_audit(environment_id,previous_policy_digest,policy_digest,safe_reason)
         VALUES($1,$2,$3,$4)`,
        [environmentId, current.effectivePolicy.digest, effectivePolicy.digest, input.reasonCode],
      );
    });
    return veilPreferenceRecordSchema.parse({
      schemaVersion: VEIL_CONTRACT_VERSION,
      environmentId,
      preferences: persisted,
      effectivePolicy,
      updatedAt: new Date().toISOString(),
    });
  }

  private async environment(principal: Principal, environmentId: string) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query<{
      policy: { allowedOrigins: string[] };
      preferences: VeilPolicyPreferences | null;
      updatedAt: Date | string | null;
    }>(
      `SELECT environment.policy,veil.preferences,veil.updated_at AS "updatedAt"
       FROM environments environment
       JOIN projects project ON project.id=environment.project_id
       LEFT JOIN veil_environment_preferences veil ON veil.environment_id=environment.id
       WHERE environment.id=$1 AND ($2::uuid IS NULL OR project.workspace_id=$2)`,
      [environmentId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Flow environment not found");
    return result.rows[0]!;
  }
}

function defaultPreferences(allowedOrigins: string[]): VeilPolicyPreferences {
  return { profile: "balanced", allowedOrigins, controls: {}, leaseTtlMs: 5_000 };
}

function snapshotPreferences(snapshot: VeilPolicySnapshot): VeilPolicyPreferences {
  return {
    profile: snapshot.profile,
    allowedOrigins: snapshot.allowedOrigins,
    controls: snapshot.controls,
    leaseTtlMs: snapshot.leaseTtlMs,
  };
}

function assertTightening(current: VeilPolicySnapshot, desired: VeilPolicySnapshot) {
  const addsOrigin = desired.allowedOrigins.some((origin) => !current.allowedOrigins.includes(origin));
  const enablesChannel = Object.entries(desired.controls).some(([key, value]) => value && !current.controls[key as keyof typeof current.controls]);
  const profileRank = { balanced: 0, custom: 0, private: 1, minimal_capture: 2 } as const;
  const weakensProfile = profileRank[desired.profile] < profileRank[current.profile];
  if (addsOrigin || enablesChannel || desired.leaseTtlMs > current.leaseTtlMs || weakensProfile) {
    throw new BadRequestException({
      code: "VEIL_PREFERENCE_WEAKENING_REFUSED",
      message: "Veil preferences may only remove origins, disable capture channels, or shorten lease duration.",
    });
  }
}
