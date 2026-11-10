import { Injectable, OnModuleDestroy } from "@nestjs/common";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { performance } from "node:perf_hooks";

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

  /** Short metadata transactions only. No browser/provider awaits under this budget.
   * A lost COMMIT acknowledgement is recovered by the caller's durable receipt. */
  async boundedTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
    timeoutMs = 5000,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new Error("SCRY_BROWSER_TRANSACTION_BUDGET_INVALID");
    const end = performance.now() + timeoutMs;
    const remaining = () => {
      const ms = Math.ceil(end - performance.now());
      if (ms <= 0) throw new Error("SCRY_BROWSER_TRANSACTION_DEADLINE_EXCEEDED");
      return ms;
    };
    let timer: NodeJS.Timeout | undefined;
    const pending = this.pool.connect();
    let client: PoolClient;
    try {
      client = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("SCRY_BROWSER_TRANSACTION_DEADLINE_EXCEEDED")),
            remaining(),
          );
        }),
      ]);
    } catch (error) {
      void pending.then((late) => late.release()).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let destroyed = false;
    const query = async (text: string, values: unknown[] = []) => {
      const config: pg.QueryConfig & { query_timeout: number } = {
        text,
        values,
        query_timeout: remaining(),
      };
      return client.query(config);
    };
    const scoped = new Proxy(client, {
      get(target, property) {
        if (property === "query")
          return async (text: string, values: unknown[] = []) => {
            await query(
              "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
              [String(remaining())],
            );
            return query(text, values);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await query("BEGIN");
      const result = await work(scoped);
      await scoped.query("SELECT 1"); // refresh the server bound before COMMIT
      await query("COMMIT");
      return result;
    } catch (error) {
      // Destroying the connection also cancels/rolls back late server work. Do
      // not return it to the pool after a caller deadline or ambiguous COMMIT.
      destroyed = true;
      client.release(true);
      throw error;
    } finally {
      if (!destroyed) client.release();
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
