import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setMissionRecordingSelectionSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";

export function registerSetMissionRecordingSelectionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "set_mission_recording_selection",
    {
      title: "Set Mission recording selection",
      description:
        "Persist the external agent's explicit ordered Run selection for the Mission recording. Run order is caller authority: Scry validates Mission ownership and stores it durably but never infers order from timestamps, ranking, confidence, accepted evidence, or Run outcome. The tool accepts Run IDs only; canonical Attempts, timeline entries, Artifacts, capture epochs, contexts, and checkpoint continuity remain factual Scry-owned provenance.",
      inputSchema: setMissionRecordingSelectionSchema,
      annotations: writes,
    },
    async (input) => {
      await client.requireCurrentRelease();

      const selection = await client.post(
        `/missions/${input.missionId}/recording-selection`,
        input,
      );

      return toolResult({ selection }, "Explicit Mission recording Run order persisted.");
    },
  );
}
