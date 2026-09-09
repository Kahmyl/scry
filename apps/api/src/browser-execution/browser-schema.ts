import type { Pool, PoolClient, QueryResultRow } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  schema_baseline: ["singleton", "runtime_capability_id", "applied_at"],
  app_users: ["id", "supabase_user_id", "email"],
  workspaces: ["id", "name", "slug"],
  workspace_memberships: ["workspace_id", "user_id", "role"],
  mcp_access_tokens: ["id", "workspace_id", "user_id", "token_hash"],
  projects: ["id", "workspace_id", "name"],
  missions: ["id", "project_id", "state", "current_objective_id", "final_report_id"],
  agent_sessions: ["id", "mission_id", "project_id", "state"],
  mission_objectives: ["id", "mission_id", "project_id", "state"],
  environments: ["id", "project_id", "base_origin", "disclosure_mode"],
  flows: ["id", "project_id", "mission_id", "state"],
  flow_revisions: ["id", "flow_id", "mission_id", "project_id", "state"],
  runs: ["id", "project_id", "mission_id", "state"],
  browser_execution_sessions: [
    "id",
    "run_id",
    "project_id",
    "mission_id",
    "state",
    "protection_key_id",
  ],
  browser_execution_outbox: ["session_id", "runtime_capability_id", "published_at"],
  browser_commands: ["id", "session_id", "run_id", "state", "safe_input"],
  browser_command_outbox: ["command_id", "published_at"],
  browser_owner_generations: ["session_id", "generation", "runtime_capability_id", "state"],
  browser_actions: ["id", "session_id", "owner_generation", "result_classification"],
  browser_effects: ["id", "session_id", "run_id", "mutation_outcome"],
  browser_effect_events: ["effect_id", "session_id", "sequence", "type"],
  browser_captures: ["id", "effect_id", "session_id", "state", "encrypted_payload"],
  protected_values: ["id", "project_id", "ciphertext", "nonce", "authentication_tag", "key_id"],
  browser_session_protected_inputs: ["session_id", "protected_value_id", "project_id"],
  browser_publications: ["id", "capture_id", "effect_id", "session_id"],
  browser_outputs: ["id", "publication_id", "effect_id", "classification"],
  browser_evidence_streams: ["id", "session_id", "run_id", "state", "chain_head"],
  browser_evidence_chunks: ["stream_id", "chunk_index", "digest", "previous_digest"],
  browser_protection_decisions: ["id", "capture_id", "effect_id", "session_id", "label"],
  browser_session_checkpoints: [
    "session_id",
    "ciphertext",
    "nonce",
    "authentication_tag",
    "key_id",
  ],
  mission_reports: ["id", "mission_id", "state", "evidence_digest"],
  artifacts: ["id", "run_id", "kind", "object_key", "digest"],
  identity_import_receipts: ["id", "mode", "identity_digest", "state", "activated_at"],
};

export async function assertBrowserSchema(database: Queryable): Promise<void> {
  const result = await database.query<SchemaColumnRow>(
    `SELECT table_name AS "tableName",column_name AS "columnName"
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [Object.keys(REQUIRED_SCHEMA)],
  );
  const available = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const columns = available.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    available.set(row.tableName, columns);
  }

  const missing: string[] = [];
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = available.get(table);
    if (!columns) {
      missing.push(table);
      continue;
    }
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`SCRY_BROWSER_SCHEMA_INCOMPLETE:${missing.sort().join(",")}`);
  }
}

interface SchemaColumnRow extends QueryResultRow {
  tableName: string;
  columnName: string;
}
