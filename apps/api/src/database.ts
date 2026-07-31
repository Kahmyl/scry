import { Injectable, OnModuleDestroy } from "@nestjs/common";
import pg, { type PoolClient, type QueryResultRow } from "pg";

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
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
