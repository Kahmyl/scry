import { createHash } from "node:crypto";
import pg from "pg";
import {
  BROWSER_RUNTIME_CAPABILITY_VERSION,
  BROWSER_V2_SCHEMA_VERSION,
} from "../src/browser-execution/browser-runtime-capability.js";
import {
  browserV2CatalogFingerprint,
  loadBrowserV2SchemaManifest,
} from "../src/browser-execution/browser-v2-schema-manifest.js";

type Mode = "rehearsal" | "permanent";
type UserRow = {
  id: string;
  supabase_user_id: string;
  email: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
};
type WorkspaceRow = { id: string; name: string; slug: string; created_at: Date };
type MembershipRow = { workspace_id: string; user_id: string; role: string; created_at: Date };
type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
};

const confirmation = process.env.BROWSER_V2_CUTOVER_CONFIRM;
const mode: Mode =
  confirmation === "REHEARSE_IDENTITY_CUTOVER"
    ? "rehearsal"
    : confirmation === "EXECUTE_IDENTITY_CUTOVER"
      ? "permanent"
      : fail("BROWSER_V2_CUTOVER_CONFIRM_REQUIRED");
const sourceUrl = required("BROWSER_V2_SOURCE_DATABASE_URL");
const targetUrl = required("BROWSER_V2_TARGET_DATABASE_URL");
const expectedSource = required("BROWSER_V2_EXPECTED_SOURCE_DATABASE");
const expectedTarget = required("BROWSER_V2_EXPECTED_TARGET_DATABASE");
if (mode === "permanent") {
  requireAttestation("BROWSER_V2_SOURCE_WRITES_FROZEN", "I_ATTEST_SOURCE_WRITES_ARE_FROZEN");
  requireAttestation("BROWSER_V2_IDENTITY_PROVIDER_CONTINUITY", "I_ATTEST_SAME_IDENTITY_PROVIDER");
}
assertDatabaseIdentity(sourceUrl, expectedSource, "SOURCE");
assertDatabaseIdentity(targetUrl, expectedTarget, "TARGET");
if (sourceUrl === targetUrl || expectedSource === expectedTarget)
  throw new Error("BROWSER_V2_CUTOVER_DATABASES_MUST_DIFFER");

const source = new pg.Pool({ connectionString: sourceUrl, max: 1 });
const target = new pg.Pool({ connectionString: targetUrl, max: 1 });
const sourceClient = await source.connect();
try {
  await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  if (mode === "permanent") {
    await sourceClient.query(
      "LOCK TABLE app_users,workspaces,workspace_memberships,projects IN SHARE MODE",
    );
  }
  const sourceIdentity = await sourceClient.query<{ database: string }>(
    "SELECT current_database() AS database",
  );
  if (sourceIdentity.rows[0]?.database !== expectedSource)
    throw new Error("BROWSER_V2_SOURCE_DATABASE_IDENTITY_MISMATCH");

  const users = await sourceClient.query<UserRow>(
    "SELECT id,supabase_user_id,email,display_name,created_at,updated_at FROM app_users ORDER BY id",
  );
  const workspaces = await sourceClient.query<WorkspaceRow>(
    "SELECT id,name,slug,created_at FROM workspaces ORDER BY id",
  );
  const memberships = await sourceClient.query<MembershipRow>(
    "SELECT workspace_id,user_id,role,created_at FROM workspace_memberships ORDER BY workspace_id,user_id",
  );
  const projects = await sourceClient.query<ProjectRow>(
    "SELECT id,workspace_id,name,description,created_at,updated_at FROM projects ORDER BY id",
  );
  validateIdentity(users.rows, workspaces.rows, memberships.rows, projects.rows);
  const identityDigest = digestIdentity(
    users.rows,
    workspaces.rows,
    memberships.rows,
    projects.rows,
  );
  const sourceDatabaseDigest = createHash("sha256").update(expectedSource).digest("hex");
  const manifest = await loadBrowserV2SchemaManifest();

  const targetClient = await target.connect();
  try {
    await targetClient.query("BEGIN");
    await targetClient.query(
      "SELECT pg_advisory_xact_lock(hashtext('browser-v2-identity-cutover'))",
    );
    const targetIdentity = await targetClient.query<{
      database: string;
      schema_version: number;
      schema_fingerprint: string;
      catalog_fingerprint: string | null;
      runtime_capability_version: string;
    }>(
      `SELECT current_database() AS database,schema_version,schema_fingerprint,
              catalog_fingerprint,runtime_capability_version
       FROM schema_baseline WHERE singleton=true FOR UPDATE`,
    );
    const targetRow = targetIdentity.rows[0];
    if (targetRow?.database !== expectedTarget)
      throw new Error("BROWSER_V2_TARGET_DATABASE_IDENTITY_MISMATCH");
    const catalogFingerprint = await browserV2CatalogFingerprint(targetClient);
    if (
      manifest.schemaVersion !== BROWSER_V2_SCHEMA_VERSION ||
      targetRow.schema_version !== BROWSER_V2_SCHEMA_VERSION ||
      targetRow.schema_fingerprint !== manifest.schemaFingerprint ||
      targetRow.catalog_fingerprint !== catalogFingerprint ||
      targetRow.runtime_capability_version !== BROWSER_RUNTIME_CAPABILITY_VERSION
    )
      throw new Error("BROWSER_V2_TARGET_CAPABILITY_MISMATCH");
    cutoverTarget: {
      const replay = await reconcileImportedIdentity(targetClient, {
        mode,
        sourceDatabaseDigest,
        identityDigest,
        users: users.rows,
        workspaces: workspaces.rows,
        memberships: memberships.rows,
        projects: projects.rows,
      });
      if (replay) {
        await targetClient.query("COMMIT");
        process.stdout.write(
          `${JSON.stringify(resultPayload({ mode, sourceDatabaseDigest, expectedTarget, identityDigest, users: users.rowCount, workspaces: workspaces.rowCount, memberships: memberships.rowCount, projects: projects.rowCount, replay: true }))}\n`,
        );
        break cutoverTarget;
      }
      await assertTargetEmpty(targetClient);

      await targetClient.query(
        `INSERT INTO app_users(id,supabase_user_id,email,display_name,created_at,updated_at)
       SELECT id,supabase_user_id,email,display_name,created_at,updated_at
       FROM jsonb_to_recordset($1::jsonb)
         AS x(id uuid,supabase_user_id uuid,email text,display_name text,created_at timestamptz,updated_at timestamptz)`,
        [JSON.stringify(users.rows)],
      );
      await targetClient.query(
        `INSERT INTO workspaces(id,name,slug,created_at)
       SELECT id,name,slug,created_at FROM jsonb_to_recordset($1::jsonb)
         AS x(id uuid,name text,slug text,created_at timestamptz)`,
        [JSON.stringify(workspaces.rows)],
      );
      await targetClient.query(
        `INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at)
       SELECT workspace_id,user_id,role,created_at FROM jsonb_to_recordset($1::jsonb)
         AS x(workspace_id uuid,user_id uuid,role text,created_at timestamptz)`,
        [JSON.stringify(memberships.rows)],
      );
      await targetClient.query(
        `INSERT INTO projects(id,workspace_id,name,description,created_at,updated_at)
       SELECT id,workspace_id,name,description,created_at,updated_at
       FROM jsonb_to_recordset($1::jsonb)
         AS x(id uuid,workspace_id uuid,name text,description text,created_at timestamptz,updated_at timestamptz)`,
        [JSON.stringify(projects.rows)],
      );
      await targetClient.query(
        `INSERT INTO identity_import_receipts(
         mode,source_database_digest,identity_digest,user_count,workspace_count,
         membership_count,project_count,state,source_configuration_disposition)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'discarded')`,
        [
          mode,
          sourceDatabaseDigest,
          identityDigest,
          users.rowCount,
          workspaces.rowCount,
          memberships.rowCount,
          projects.rowCount,
          mode === "rehearsal" ? "rehearsal_complete" : "identity_imported",
        ],
      );
      await assertImportedCounts(targetClient, {
        app_users: users.rowCount,
        workspaces: workspaces.rowCount,
        workspace_memberships: memberships.rowCount,
        projects: projects.rowCount,
      });
      try {
        await targetClient.query("COMMIT");
      } catch (error) {
        if (
          !(await reconcileCommittedImport(target, {
            mode,
            sourceDatabaseDigest,
            identityDigest,
            users: users.rows,
            workspaces: workspaces.rows,
            memberships: memberships.rows,
            projects: projects.rows,
          }))
        )
          throw error;
      }
      process.stdout.write(
        `${JSON.stringify(resultPayload({ mode, sourceDatabaseDigest, expectedTarget, identityDigest, users: users.rowCount, workspaces: workspaces.rowCount, memberships: memberships.rowCount, projects: projects.rowCount, replay: false }))}\n`,
      );
    }
  } catch (error) {
    await targetClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    targetClient.release();
  }
  await sourceClient.query("ROLLBACK");
} catch (error) {
  await sourceClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  sourceClient.release();
  await Promise.all([source.end(), target.end()]);
}

type ImportedIdentity = Readonly<{
  mode: Mode;
  sourceDatabaseDigest: string;
  identityDigest: string;
  users: UserRow[];
  workspaces: WorkspaceRow[];
  memberships: MembershipRow[];
  projects: ProjectRow[];
}>;

async function reconcileCommittedImport(targetPool: pg.Pool, expected: ImportedIdentity) {
  const client = await targetPool.connect();
  try {
    return await reconcileImportedIdentity(client, expected);
  } finally {
    client.release();
  }
}

async function reconcileImportedIdentity(client: pg.PoolClient, expected: ImportedIdentity) {
  const receipt = await client.query<{
    mode: Mode;
    source_database_digest: string;
    identity_digest: string;
    user_count: number;
    workspace_count: number;
    membership_count: number;
    project_count: number;
  }>(
    `SELECT mode,source_database_digest,identity_digest,user_count,workspace_count,
            membership_count,project_count
     FROM identity_import_receipts WHERE identity_digest=$1`,
    [expected.identityDigest],
  );
  if (!receipt.rows[0]) return false;
  const row = receipt.rows[0];
  if (
    row.mode !== expected.mode ||
    row.source_database_digest !== expected.sourceDatabaseDigest ||
    row.user_count !== expected.users.length ||
    row.workspace_count !== expected.workspaces.length ||
    row.membership_count !== expected.memberships.length ||
    row.project_count !== expected.projects.length
  )
    throw new Error("BROWSER_V2_IMPORT_RECEIPT_CONFLICT");
  const users = await client.query<UserRow>(
    "SELECT id,supabase_user_id,email,display_name,created_at,updated_at FROM app_users ORDER BY id",
  );
  const workspaces = await client.query<WorkspaceRow>(
    "SELECT id,name,slug,created_at FROM workspaces ORDER BY id",
  );
  const memberships = await client.query<MembershipRow>(
    "SELECT workspace_id,user_id,role,created_at FROM workspace_memberships ORDER BY workspace_id,user_id",
  );
  const projects = await client.query<ProjectRow>(
    "SELECT id,workspace_id,name,description,created_at,updated_at FROM projects ORDER BY id",
  );
  if (
    digestIdentity(users.rows, workspaces.rows, memberships.rows, projects.rows) !==
    expected.identityDigest
  )
    throw new Error("BROWSER_V2_IMPORTED_IDENTITY_DRIFT");
  return true;
}

function resultPayload(input: {
  mode: Mode;
  sourceDatabaseDigest: string;
  expectedTarget: string;
  identityDigest: string;
  users: number | null;
  workspaces: number | null;
  memberships: number | null;
  projects: number | null;
  replay: boolean;
}) {
  return {
    verdict: "pass",
    mode: input.mode,
    replay: input.replay,
    sourceDatabaseDigest: input.sourceDatabaseDigest,
    targetDatabase: input.expectedTarget,
    runtimeCapabilityVersion: BROWSER_RUNTIME_CAPABILITY_VERSION,
    identityDigest: input.identityDigest,
    sourceConfigurationDisposition: "discarded",
    nextRequiredState: input.mode === "permanent" ? "activate_after_legacy_retirement" : null,
    counts: {
      users: input.users,
      workspaces: input.workspaces,
      memberships: input.memberships,
      projects: input.projects,
    },
  };
}

async function assertTargetEmpty(client: pg.PoolClient): Promise<void> {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname='public' AND tablename NOT IN ('schema_baseline','identity_import_receipts')
     ORDER BY tablename`,
  );
  for (const { tablename } of tables.rows) {
    if (!/^[a-z][a-z0-9_]*$/u.test(tablename))
      throw new Error("BROWSER_V2_TARGET_TABLE_NAME_INVALID");
    const count = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${tablename}`,
    );
    if (Number(count.rows[0]?.count) !== 0)
      throw new Error(`BROWSER_V2_TARGET_NOT_EMPTY:${tablename}`);
  }
  const receipts = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM identity_import_receipts",
  );
  if (Number(receipts.rows[0]?.count) !== 0) throw new Error("BROWSER_V2_TARGET_ALREADY_IMPORTED");
}

async function assertImportedCounts(
  client: pg.PoolClient,
  expected: Readonly<Record<string, number | null>>,
): Promise<void> {
  for (const [table, expectedCount] of Object.entries(expected)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table) || expectedCount === null)
      throw new Error("BROWSER_V2_IDENTITY_COUNT_INVALID");
    const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    if (Number(count.rows[0]?.count) !== expectedCount)
      throw new Error(`BROWSER_V2_IDENTITY_COUNT_MISMATCH:${table}`);
  }
}

function validateIdentity(
  users: UserRow[],
  workspaces: WorkspaceRow[],
  memberships: MembershipRow[],
  projects: ProjectRow[],
): void {
  if (users.length === 0 || workspaces.length === 0)
    throw new Error("BROWSER_V2_SOURCE_IDENTITY_EMPTY");
  const userIds = new Set(users.map(({ id }) => id));
  const workspaceIds = new Set(workspaces.map(({ id }) => id));
  if (
    memberships.some(
      ({ user_id, workspace_id }) => !userIds.has(user_id) || !workspaceIds.has(workspace_id),
    ) ||
    projects.some(({ workspace_id }) => !workspaceIds.has(workspace_id))
  )
    throw new Error("BROWSER_V2_SOURCE_IDENTITY_REFERENTIAL_GAP");
}

function digestIdentity(
  users: UserRow[],
  workspaces: WorkspaceRow[],
  memberships: MembershipRow[],
  projects: ProjectRow[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ users, workspaces, memberships, projects }))
    .digest("hex");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requireAttestation(name: string, expected: string): void {
  if (process.env[name] !== expected) throw new Error(`${name}_REQUIRED`);
}

function assertDatabaseIdentity(url: string, expected: string, label: string): void {
  const actual = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));
  if (!actual || actual !== expected)
    throw new Error(`BROWSER_V2_${label}_DATABASE_IDENTITY_MISMATCH`);
}

function fail(message: string): never {
  throw new Error(message);
}
