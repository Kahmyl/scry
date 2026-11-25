import type { PoolClient } from "pg";
import type { AdmittedGeneratedSecret, GeneratedSecretMetadata } from "@scry/contracts";
import { persistedNativeActionResult, captureGeneratedSecretSchema } from "@scry/contracts";
import type { BrowserProtectedValueCipher } from "../protected-value-cipher.js";
export const generatedMetadataProjection = `id AS "protectedValueId",display_name AS "displayName",CASE WHEN state='active' AND expires_at<=now() THEN 'expired' ELSE state END AS state,source_origin AS "sourceOrigin",run_id AS "sourceRunId",native_source_command_id AS "sourceCommandId",source_environment_id AS "environmentId",source_owner_generation AS "sourceOwnerGeneration",permitted_uses AS "permittedUses",expires_at AS "expiresAt"`;
/** The caller holds the exact live command claim; no browser or crypto await. */
export async function persistGeneratedSecret(
  c: PoolClient,
  commandId: string,
  value: AdmittedGeneratedSecret,
  cipher: BrowserProtectedValueCipher,
): Promise<GeneratedSecretMetadata> {
  const m = value.metadata;
  const scope = (
    await c.query(
      `SELECT s.*,c.protected_input_ciphertext,c.protected_input_nonce,c.protected_input_authentication_tag,c.protected_input_digest,c.protected_input_key_id FROM browser_commands c JOIN browser_execution_sessions s ON s.id=c.session_id WHERE c.id=$1 AND c.safe_input->>'tool'='browser_capture_secret' AND s.state='active' AND s.stop_requested_at IS NULL FOR UPDATE OF s`,
      [commandId],
    )
  ).rows[0];
  if (
    !scope ||
    m.sourceCommandId !== commandId ||
    m.sourceRunId !== scope.run_id ||
    m.sourceOwnerGeneration !== Number(scope.active_owner_generation) ||
    m.environmentId !== scope.environment_id ||
    ![...scope.allowed_first_party_origins, ...scope.allowed_service_origins].includes(
      m.sourceOrigin,
    ) ||
    m.state !== "active" ||
    !Number.isFinite(Date.parse(m.expiresAt)) ||
    Date.parse(m.expiresAt) <= Date.now() ||
    Date.parse(m.expiresAt) > Date.now() + 86401000
  )
    throw Error("SCRY_BROWSER_PROTECTED_VALUE_UNAVAILABLE");
  const intended = captureGeneratedSecretSchema.parse(
    JSON.parse(
      cipher.decrypt(
        {
          ciphertext: scope.protected_input_ciphertext,
          nonce: scope.protected_input_nonce,
          authenticationTag: scope.protected_input_authentication_tag,
          valueDigest: scope.protected_input_digest,
          keyId: scope.protected_input_key_id,
        },
        { sessionId: scope.id, commandId, field: "publicValue" },
      ),
    ),
  );
  if (
    m.sourceOrigin !== intended.sourceOrigin ||
    JSON.stringify(m.permittedUses) !== JSON.stringify(intended.permittedUses) ||
    Date.parse(m.expiresAt) > Date.now() + intended.expiresInSeconds * 1000 + 1000
  )
    throw Error("SCRY_BROWSER_PROTECTED_VALUE_UNAVAILABLE");
  const owner = await c.query(
    "SELECT generation FROM browser_owner_generations WHERE session_id=$1 AND generation=$2 AND state='active' AND lease_expires_at>clock_timestamp() FOR UPDATE",
    [scope.id, m.sourceOwnerGeneration],
  );
  if (!owner.rowCount) throw Error("SCRY_BROWSER_OWNER_FENCED");
  const prior = await c.query<GeneratedSecretMetadata>(
    `SELECT ${generatedMetadataProjection} FROM protected_values WHERE native_source_command_id=$1`,
    [commandId],
  );
  if (prior.rows[0]) return prior.rows[0];
  const e = value.encrypted;
  const result = await c.query<GeneratedSecretMetadata>(
    `INSERT INTO protected_values(id,project_id,mission_id,run_id,source_kind,display_name,external_reference,ciphertext,nonce,authentication_tag,value_digest,key_id,state,expires_at,idempotency_key,native_source_command_id,native_source_session_id,source_environment_id,source_origin,permitted_uses,source_owner_generation) VALUES($1,$2,$3,$4,'browser_generated',$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${generatedMetadataProjection}`,
    [
      m.protectedValueId,
      scope.project_id,
      scope.mission_id,
      scope.run_id,
      m.displayName,
      `protected://native/${m.protectedValueId}`,
      e.ciphertext,
      e.nonce,
      e.authenticationTag,
      e.valueDigest,
      e.keyId,
      m.expiresAt,
      `native-capture-${commandId}`,
      commandId,
      scope.id,
      m.environmentId,
      m.sourceOrigin,
      m.permittedUses,
      m.sourceOwnerGeneration,
    ],
  );
  await c.query(
    "INSERT INTO browser_session_protected_inputs(session_id,protected_value_id,project_id) VALUES($1,$2,$3)",
    [scope.id, m.protectedValueId, scope.project_id],
  );
  // Lost replies/restarts recover the same handoff without re-reading a reveal.
  await c.query("UPDATE browser_commands SET safe_result=$2::jsonb WHERE id=$1", [
    commandId,
    JSON.stringify(
      persistedNativeActionResult({
        execution: "completed",
        businessOutcome: "not_dispatched",
        observation: "available",
        protectedReferences: [result.rows[0]],
        content: [],
      }),
    ),
  ]);
  return result.rows[0]!;
}
