import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResultRow } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type BrowserV2SchemaManifest = Readonly<{
  migrationNames: string[];
  schemaFingerprint: string;
  schemaVersion: number;
}>;

let cachedManifest: Promise<BrowserV2SchemaManifest> | undefined;

export function loadBrowserV2SchemaManifest(): Promise<BrowserV2SchemaManifest> {
  cachedManifest ??= readManifest();
  return cachedManifest;
}

export async function browserV2CatalogFingerprint(database: Queryable): Promise<string> {
  const columns = await database.query<CatalogRow>(
    `SELECT table_name AS "tableName",ordinal_position AS "position",column_name AS "name",
              data_type AS "dataType",udt_name AS "udtName",is_nullable AS "nullable",
              coalesce(column_default,'') AS "default"
       FROM information_schema.columns WHERE table_schema='public'
       ORDER BY table_name,ordinal_position`,
  );
  const constraints = await database.query<CatalogRow>(
    `SELECT c.relname AS "tableName",x.conname AS "name",x.contype AS "type",
              pg_get_constraintdef(x.oid,true) AS "definition"
       FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' ORDER BY c.relname,x.conname`,
  );
  const indexes = await database.query<CatalogRow>(
    `SELECT tablename AS "tableName",indexname AS "name",indexdef AS "definition"
       FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
      }),
    )
    .digest("hex");
}

async function readManifest(): Promise<BrowserV2SchemaManifest> {
  const directory = fileURLToPath(new URL("../../migrations-v2/", import.meta.url));
  const migrationNames = (await readdir(directory))
    .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
    .sort();
  if (migrationNames.length === 0) throw new Error("BROWSER_V2_MIGRATIONS_MISSING");
  const migrations = await Promise.all(
    migrationNames.map(async (name) => ({
      name,
      source: await readFile(path.join(directory, name), "utf8"),
    })),
  );
  return {
    migrationNames,
    schemaVersion: migrationNames.length,
    schemaFingerprint: createHash("sha256")
      .update(
        migrations.map(({ name, source }) => `${name}\n${source}`).join("\n-- next migration --\n"),
      )
      .digest("hex"),
  };
}

interface CatalogRow extends QueryResultRow {
  [key: string]: unknown;
}
