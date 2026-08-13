import { Injectable, OnModuleDestroy } from "@nestjs/common";
import pg, { type PoolClient, type QueryResultRow } from "pg";

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
    connectionTimeoutMillis: databaseTimeout("DATABASE_CONNECTION_TIMEOUT_MS", 5_000),
    statement_timeout: databaseTimeout("DATABASE_STATEMENT_TIMEOUT_MS", 30_000),
    lock_timeout: databaseTimeout("DATABASE_LOCK_TIMEOUT_MS", 5_000),
    idle_in_transaction_session_timeout: databaseTimeout(
      "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
      30_000,
    ),
    // Caller timeout is intentionally longer than the server statement timeout:
    // PostgreSQL gets the first opportunity to return an authoritative result.
    query_timeout: databaseTimeout("DATABASE_QUERY_TIMEOUT_MS", 35_000),
  });

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

function databaseTimeout(name: string, fallback: number) {
  const configured = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error(`${name}_INVALID`);
  }
  return configured;
}
