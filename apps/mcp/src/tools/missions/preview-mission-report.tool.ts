import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionReportPreviewSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult, uuid } from "../../tool-registry.js";

export function registerPreviewMissionReportTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "preview_mission_report",
    {
      title: "Preview Mission report composition",
      description:
        "Preview the exact typed evidence and recording composition that publication would freeze, together with canonical readiness blockers. A null snapshot means the explicit selection is missing, stale, unavailable, gapped, or otherwise inadmissible; resolve the returned blocker instead of fabricating or silently omitting evidence.",
      inputSchema: { missionId: uuid },
      outputSchema: z.object({ message: z.string(), preview: missionReportPreviewSchema }).strict(),
      annotations: readOnly,
    },
    async ({ missionId }) =>
      toolResult(
        {
          preview: missionReportPreviewSchema.parse(
            await client.get(`/missions/${missionId}/report-preview`),
          ),
        },
        "Mission report composition preview loaded.",
      ),
  );
}
