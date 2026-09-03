import { executionPolicySchema } from "@scry/contracts";

import { Database } from "../src/infrastructure/database.js";

const EXPECTED = {
  origin: "https://preview.vitract.com",
  authority: {
    provider: "vitract",
    resourceKind: "credential_record",
    resourceScope: "vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a",
    resourceCollection: "partner_application_credentials",
    semanticField: "clientId",
    classification: "internal_non_secret",
    permittedPurpose: "browser_presentation_identity",
    browserBoundaryKind: "row",
    contractVersion: 1,
    revision: 2,
    status: "active",
  },
} as const;

export async function configureVitractPresentationAuthority(database: Database) {
  return database.transaction(async (client) => {
    const result = await client.query<{
      policy: unknown;
      baseOrigin: string;
      projectId: string;
      environmentId: string;
    }>(
      `SELECT environment.policy,environment.base_origin AS "baseOrigin",
              environment.project_id::text AS "projectId",environment.id::text AS "environmentId"
         FROM q5_canonical_scope_designations designation
         JOIN environments environment ON environment.id=designation.environment_id
        WHERE designation.qualification_key='m6-q5-authoritative'
          AND designation.project_id=environment.project_id FOR UPDATE`,
    );
    if (result.rowCount !== 1) throw new Error("VITRACT_PRESENTATION_AUTHORITY_OWNER_MISMATCH");
    const policy = executionPolicySchema.parse(result.rows[0]!.policy);
    if (!policy.allowedOrigins.includes(EXPECTED.origin))
      throw new Error("VITRACT_PRESENTATION_AUTHORITY_OWNER_MISMATCH");
    const authorities = policy.externalResourcePresentationAuthorities ?? [];
    const sameRevision = authorities.filter(
      (candidate) =>
        candidate.provider === EXPECTED.authority.provider &&
        candidate.resourceKind === EXPECTED.authority.resourceKind &&
        candidate.resourceScope === EXPECTED.authority.resourceScope &&
        candidate.contractVersion === EXPECTED.authority.contractVersion &&
        candidate.revision === EXPECTED.authority.revision,
    );
    if (
      sameRevision.length > 1 ||
      (sameRevision.length === 1 &&
        JSON.stringify(sameRevision[0]) !== JSON.stringify(EXPECTED.authority))
    )
      throw new Error("VITRACT_PRESENTATION_AUTHORITY_REVISION_CONFLICT");
    if (sameRevision.length === 1) return "already_configured" as const;
    const superseded = authorities.map((candidate) =>
      candidate.provider === EXPECTED.authority.provider &&
      candidate.resourceKind === EXPECTED.authority.resourceKind &&
      candidate.resourceScope === EXPECTED.authority.resourceScope &&
      candidate.contractVersion === EXPECTED.authority.contractVersion &&
      candidate.status === "active"
        ? { ...candidate, status: "revoked" as const }
        : candidate,
    );
    const updated = executionPolicySchema.parse({
      ...policy,
      externalResourcePresentationAuthorities: [...superseded, EXPECTED.authority],
    });
    await client.query(`UPDATE environments SET policy=$3::jsonb WHERE id=$1 AND project_id=$2`, [
      result.rows[0]!.environmentId,
      result.rows[0]!.projectId,
      JSON.stringify(updated),
    ]);
    return "configured" as const;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = new Database();
  try {
    const result = await configureVitractPresentationAuthority(database);
    process.stdout.write(`vitractPresentationAuthority: ${result}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "VITRACT_PRESENTATION_AUTHORITY_CONFIGURATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    await database.onModuleDestroy();
  }
}
