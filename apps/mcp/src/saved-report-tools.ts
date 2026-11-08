import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserApiClient } from "./api-client.js";
import { protectedResourceMetadata, toolAuthMetadata } from "./oauth-discovery.js";
import { localFactualRead, toolResult, uuid } from "./tool-registry.js";

export const reportNavigationSchema = {
  reportUrl: z.string().url().optional(),
  evidenceUrl: z.string().url().optional(),
};

/** Operator configuration only. Never infer a public dashboard from an internal API host. */
export function reportNavigation(env = process.env) {
  const resource = protectedResourceMetadata(env)?.resource;
  const configured = env.SCRY_WEB_ORIGIN || (resource ? new URL(resource).origin : undefined);
  let origin: string | undefined;
  if (configured) {
    const url = new URL(configured);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (resource && url.origin !== new URL(resource).origin)
    )
      throw new Error("SCRY_WEB_ORIGIN_INVALID");
    origin = url.origin;
  }
  return (reportId: unknown): { reportUrl?: string; evidenceUrl?: string } => {
    if (!origin || !uuid.safeParse(reportId).success) return {};
    const reportUrl = new URL(`/dashboard/reports/${reportId}`, origin).href;
    return { reportUrl, evidenceUrl: `${reportUrl}#supporting-evidence` };
  };
}

export function registerSavedReportTools(
  server: McpServer,
  client: BrowserApiClient,
  navigation: ReturnType<typeof reportNavigation>,
) {
  server.registerTool(
    "list_reports",
    {
      title: "List saved Project reports",
      description:
        "Locate existing reports in a visible Project by title and summary. Returns the customer report projection and dashboard navigation links when the public web origin is configured. Read only; does not start or rerun testing.",
      inputSchema: { projectId: uuid },
      outputSchema: { message: z.string(), reports: z.array(z.record(z.string(), z.unknown())) },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ projectId }) => {
      const reports = await client.get<Array<Record<string, unknown>>>(
        `/projects/${projectId}/reports`,
      );
      return toolResult(
        { reports: reports.map((report) => ({ ...report, ...navigation(report.id) })) },
        "Saved customer reports loaded. Evidence availability is not proof of visual review.",
      );
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "Read saved application report",
      description:
        "Read an existing report's recorded application checks, limitations, evidence references and coverage through the workspace-scoped customer API. Use this for independent review, including reports created outside this chat. Returned reportUrl and evidenceUrl are authenticated dashboard navigation links, not public media URLs. Evidence metadata is not proof that an image or recording was viewed. Missing links mean no public web origin is configured; do not invent a host or rerun the test.",
      inputSchema: { reportId: uuid },
      outputSchema: {
        message: z.string(),
        report: z.record(z.string(), z.unknown()),
        ...reportNavigationSchema,
      },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ reportId }) =>
      toolResult(
        {
          report: await client.get<Record<string, unknown>>(`/reports/${reportId}`),
          ...navigation(reportId),
        },
        "Saved customer report loaded. Evidence links open the authenticated dashboard; media has not been viewed by this read.",
      ),
  );
}
