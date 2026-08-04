import { Module } from "@nestjs/common";

import { Database } from "./database.js";
import { RedisConnection } from "./redis.js";

@Module({
  providers: [Database, RedisConnection],
  exports: [Database, RedisConnection],
})
export class InfrastructureModule {}
