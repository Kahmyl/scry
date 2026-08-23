import { Module } from "@nestjs/common";

import { Database } from "./database.js";
import { RedisConnection } from "./redis.js";
import { OperationalEvents } from "./operational-events.js";

@Module({
  providers: [Database, RedisConnection, OperationalEvents],
  exports: [Database, RedisConnection, OperationalEvents],
})
export class InfrastructureModule {}
