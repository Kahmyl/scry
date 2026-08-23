import { Module } from "@nestjs/common";

import { Database } from "./database.js";
import { RedisConnection } from "./redis.js";
import { OperationalEvents } from "./operational-events.js";
import { OperationalEventStore } from "./operational-event-store.js";
import { OperationalEventsController } from "./operational-events.controller.js";

@Module({
  controllers: [OperationalEventsController],
  providers: [Database, RedisConnection, OperationalEventStore, OperationalEvents],
  exports: [Database, RedisConnection, OperationalEventStore, OperationalEvents],
})
export class InfrastructureModule {}
