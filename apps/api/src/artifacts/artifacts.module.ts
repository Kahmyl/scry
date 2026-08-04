import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { ArtifactController } from "./artifact.controller.js";
import { artifactStoreProvider } from "./artifact-storage.provider.js";
import { ArtifactService } from "./services/artifact.service.js";

@Module({
  imports: [AccessModule],
  controllers: [ArtifactController],
  providers: [artifactStoreProvider, ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactsModule {}
