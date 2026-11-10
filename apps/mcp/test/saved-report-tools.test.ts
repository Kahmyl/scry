import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserApiClient } from "../src/api-client.js";
import { createBrowserMcpServer } from "../src/server.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const missionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const reportUrl = `https://review.example/dashboard/reports/${reportId}`;
const report = {
  id: reportId,
  missionId,
  projectId,
  summary: "Support information checked; email delivery excluded",
  safeReport: {
    presentation: {
      subject: "application",
      scope: ["Support"],
      checks: [
        {
          title: "Support heading",
          expected: "Support heading is visible",
          actual: "Visible",
          status: "matched_expectation",
          evidence: [],
        },
      ],
      observations: [],
      limitations: ["Email delivery was not tested"],
    },
  },
  evidenceCoverage: { runs: 1, complete: 0, incomplete: 0, missing: 1, open: 0 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connected(native = false) {
  vi.stubEnv("SCRY_BROWSER_ADAPTER", native ? "playwright_mcp" : "legacy");
  vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", native ? "true" : "false");
  vi.stubEnv("SCRY_OAUTH_ENABLED", "false");
  vi.stubEnv("SCRY_WEB_ORIGIN", "https://review.example");
  const server = createBrowserMcpServer(
    new BrowserApiClient("http://api.internal/api", "scoped-token"),
  );
  const client = new Client({ name: "independent-report-reader", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

describe("saved report review without conversation history", () => {
  it.each([false, true])(
    "discovers and reads existing customer reports without starting work (native=%s)",
    async (native) => {
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith(`/projects/${projectId}/reports`))
          return Response.json([report]);
        if (String(input).endsWith(`/reports/${reportId}`)) return Response.json(report);
        return Response.json({ code: "UNEXPECTED_REQUEST" }, { status: 500 });
      });
      vi.stubGlobal("fetch", fetcher);
      const { client, server } = await connected(native);
      try {
        const tools = (await client.listTools()).tools;
        for (const name of ["list_reports", "get_report"]) {
          expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          });
        }
        const list = await client.callTool({ name: "list_reports", arguments: { projectId } });
        expect(list.structuredContent).toMatchObject({
          reports: [{ ...report, reportUrl, evidenceUrl: `${reportUrl}#supporting-evidence` }],
        });
        const saved = await client.callTool({ name: "get_report", arguments: { reportId } });
        expect(saved.isError).not.toBe(true);
        expect(saved.structuredContent).toMatchObject({
          report,
          reportUrl,
          evidenceUrl: `${reportUrl}#supporting-evidence`,
        });
        expect(client.getInstructions()).toContain("list_projects");
        expect(tools.find((t) => t.name === "get_report")?.description).toContain("not proof");
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
          expect(init.method).toBeUndefined();
          expect(init.body).toBeUndefined();
          expect(new Headers(init.headers).get("authorization")).toBe("Bearer scoped-token");
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each([403, 404])(
    "preserves inaccessible/missing report failure (%s) without fallback",
    async (status) => {
      const fetcher = vi.fn(async (_input: string | URL | Request) =>
        Response.json({ code: "SCRY_BROWSER_REPORT_NOT_FOUND" }, { status }),
      );
      vi.stubGlobal("fetch", fetcher);
      const { client, server } = await connected();
      try {
        const result = await client.callTool({ name: "get_report", arguments: { reportId } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(reportUrl);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("operator");
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("rejects invalid report IDs before calling the API", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { client, server } = await connected();
    try {
      const result = await client.callTool({
        name: "get_report",
        arguments: { reportId: "../operator" },
      });
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns navigation links after publication and replay without a second request", async () => {
    const fetcher = vi.fn(async () => Response.json({ reportId, replay: true }));
    vi.stubGlobal("fetch", fetcher);
    const { client, server } = await connected();
    try {
      const result = await client.callTool({
        name: "publish_mission_report",
        arguments: {
          missionId,
          agentSessionId: projectId,
          summary: report.summary,
          safeReport: report.safeReport,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        reportId,
        replay: true,
        reportUrl,
        evidenceUrl: `${reportUrl}#supporting-evidence`,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("links an observed Mission's final saved report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: missionId, finalReportId: reportId })),
    );
    const { client, server } = await connected();
    try {
      const result = await client.callTool({ name: "get_mission", arguments: { missionId } });
      expect(result.structuredContent).toMatchObject({
        mission: { finalReportId: reportId },
        reportUrl,
        evidenceUrl: `${reportUrl}#supporting-evidence`,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
