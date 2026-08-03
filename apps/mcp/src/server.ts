import { ScryApiClient } from "./api-client.js";
import { createScryServerComposition } from "./server-composition.js";
import { registerArtifactsTools } from "./tools/artifacts/index.js";
import { registerAuthoringTools } from "./tools/authoring/index.js";
import { registerCoreTools } from "./tools/core/index.js";
import { registerFlowsTools } from "./tools/flows/index.js";
import { registerMissionsTools } from "./tools/missions/index.js";
import { registerProjectsTools } from "./tools/projects/index.js";
import { registerRunsTools } from "./tools/runs/index.js";

export function createScryMcpServer(client = new ScryApiClient()) {
  const server = createScryServerComposition();
  registerCoreTools(server, client);
  registerMissionsTools(server, client);
  registerProjectsTools(server, client);
  registerFlowsTools(server, client);
  registerAuthoringTools(server, client);
  registerRunsTools(server, client);
  registerArtifactsTools(server, client);
  return server;
}
