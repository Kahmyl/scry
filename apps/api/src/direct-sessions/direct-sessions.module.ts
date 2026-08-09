import { Module } from "@nestjs/common";
import { InfrastructureModule } from "../infrastructure/index.js";
import { DirectSessionController } from "./direct-session.controller.js";
import { DirectSessionService } from "./direct-session.service.js";

@Module({ imports: [InfrastructureModule], controllers: [DirectSessionController], providers: [DirectSessionService] })
export class DirectSessionsModule {}
