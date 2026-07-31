import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

@Injectable()
export class RedisConnection implements OnModuleDestroy {
  readonly client = new Redis(
    process.env.REDIS_URL ?? "redis://127.0.0.1:56389",
    { maxRetriesPerRequest: null },
  );

  async onModuleDestroy() {
    await this.client.quit();
  }
}
