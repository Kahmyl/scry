import { Module } from "@nestjs/common";

import { AccessModule } from "../access/index.js";
import { ArtifactController } from "./artifact.controller.js";
import { ARTIFACT_STORE, artifactStoreProvider } from "./artifact-storage.provider.js";
import { ArtifactService } from "./services/artifact.service.js";

@Module({
  imports: [AccessModule],
  controllers: [ArtifactController],
  providers: [artifactStoreProvider, ArtifactService],
  exports: [ARTIFACT_STORE, ArtifactService],
})
export class ArtifactsModule {}
