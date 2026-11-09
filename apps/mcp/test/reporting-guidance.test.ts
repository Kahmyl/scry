import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
import { publishBrowserMissionReportSchema } from "@scry/contracts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("self-contained external-agent reporting guidance", () => {
  it.each([false, true])(
    "delivers reporting direction and structured fields on a fresh connection (native=%s)",
    async (native) => {
      vi.stubEnv("SCRY_BROWSER_ADAPTER", native ? "playwright_mcp" : "legacy");
      vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", native ? "true" : "false");
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const server = createBrowserMcpServer(new BrowserApiClient("http://unused.test/api"));
      const client = new Client({ name: "fresh-reporting-reader", version: "baseline" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        const instructions = client.getInstructions()!;
        expect(instructions).toContain(
          "Customer reports describe the tested application, not Scry",
        );
        expect(instructions).toContain("safeReport.presentation");
        expect(instructions).toContain("not_tested");
        expect(instructions).toContain("inconclusive");
        expect(instructions).toContain("No automatic retry");
        expect(instructions).toContain("operator diagnostics");
        expect(instructions).toContain("Before asking a question, review the current conversation");
        expect(instructions).toContain("do not make them repeat an answer");
        expect(instructions).toContain(
          "does not override the client's approval or safety requirements",
        );
        expect(instructions).toContain("State the exact action/account, why it is needed");
        expect(instructions).toContain(
          "Never accept agreements or consequential actions from silence",
        );
        expect(instructions).toContain("Continue independent checks while waiting");
        expect(instructions).toContain("Do not ask customers for internal IDs");
        expect(instructions).toContain("unsupported workspace administration");
        expect(instructions).toContain("in the same reply");
        expect(instructions).toContain("https://scry.giize.com/support");
        expect(instructions).toContain("Do not invent an administration screen");
        expect(instructions).toContain(
          "Separate operations exercised from successful business journeys",
        );
        expect(instructions).toContain("Put the most consequential recorded limitations first");
        expect(instructions).toContain(
          "not exhaustive requested-scenario coverage or unique defects",
        );
        expect(instructions).toContain("Distinguish a deliberately excluded check");
        expect(instructions).toContain("why the test was not carried out");
        expect(instructions).toContain("If the reason is unknown, say so instead of inventing one");
        expect(instructions).toContain("not automatically confirmed defects");
        expect(instructions).toContain("Example report payload");
        const example = JSON.parse(
          /Example report payload[^\n]*?: (\{[^\n]+\})$/.exec(instructions)![1]!,
        );
        expect(
          publishBrowserMissionReportSchema.safeParse({
            ...example,
            agentSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }).success,
        ).toBe(true);
        const report = (await client.listTools()).tools.find(
          (t) => t.name === "publish_mission_report",
        )!;
        const mission = (await client.listTools()).tools.find((t) => t.name === "get_mission")!;
        const finalization = (await client.listTools()).tools.find(
          (t) => t.name === "finalize_run",
        )!;
        expect(finalization.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(mission.description).toContain("review their earlier answers and available tools");
        expect(mission.description).toContain("Never infer new approval");
        const safe = report.inputSchema.properties?.safeReport as Record<string, unknown>;
        const properties = safe.properties as Record<string, unknown>;
        expect(properties.presentation).toBeTruthy();
        expect(JSON.stringify(properties.presentation)).toContain('"matched_expectation"');
        expect(JSON.stringify(properties.presentation)).toContain('"not_tested"');
        expect(JSON.stringify(properties.presentation)).toContain('"expected"');
        expect(JSON.stringify(properties.presentation)).toContain('"artifactId"');
        expect(fetcher).not.toHaveBeenCalled();
        const invalid = await client.callTool({
          name: "publish_mission_report",
          arguments: {
            missionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            agentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            summary: "Do not grade a tool",
            safeReport: {
              presentation: {
                subject: "application",
                checks: [{ title: "Browser tool", actual: "Tool returned", status: "passed" }],
              },
            },
          },
        });
        expect(invalid.isError).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
