import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
import { publishBrowserMissionReportSchema } from "@scry/contracts";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("self-contained external-agent reporting guidance", () => {
  it.each([false, true])(
    "supports clients caching the original Project output schema (native=%s)",
    async (native) => {
      vi.stubEnv("SCRY_BROWSER_ADAPTER", native ? "playwright_mcp" : "legacy");
      vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", native ? "true" : "false");
      const fetcher = vi.fn(async () => Response.json([]));
      vi.stubGlobal("fetch", fetcher);
      const server = createBrowserMcpServer(new BrowserApiClient("http://fixture.test/api"));
      const client = new Client({ name: "cached-project-schema", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        const { tools } = await client.listTools();
        // Exact strict output shape advertised by production fc726a35. An old
        // client's cached validator must accept the new handler's actual result.
        server.server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: tools.map((tool) =>
            tool.name !== "list_projects"
              ? tool
              : {
                  ...tool,
                  outputSchema: {
                    $schema: "http://json-schema.org/draft-07/schema#",
                    type: "object" as const,
                    properties: {
                      message: { type: "string" },
                      projects: {
                        type: "array",
                        items: {
                          type: "object",
                          propertyNames: { type: "string" },
                          additionalProperties: {},
                        },
                      },
                    },
                    required: ["message", "projects"],
                    additionalProperties: false,
                  },
                },
          ),
        }));
        await client.listTools();
        const result = await client.callTool({ name: "list_projects", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ projects: [] });
        expect((result.structuredContent as Record<string, unknown>).message).toContain(
          "unsupported workspace administration",
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it.each([false, true])(
    "delivers reporting direction and structured fields on a fresh connection (native=%s)",
    async (native) => {
      vi.stubEnv("SCRY_BROWSER_ADAPTER", native ? "playwright_mcp" : "legacy");
      vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", native ? "true" : "false");
      const fetcher = vi.fn(async (url: string) =>
        Response.json(url.endsWith("/projects") ? [] : { ready: true }),
      );
      vi.stubGlobal("fetch", fetcher);
      const server = createBrowserMcpServer(new BrowserApiClient("http://unused.test/api"));
      const client = new Client({ name: "fresh-reporting-reader", version: "baseline" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        expect(client.getInstructions()).toBe("Use list_projects.");
        expect(fetcher).not.toHaveBeenCalled();
        const discovery = await client.callTool({ name: "list_projects", arguments: {} });
        expect(discovery.isError).not.toBe(true);
        expect(discovery.structuredContent).toMatchObject({ projects: [] });
        const discoveryGuidance = (
          (discovery.structuredContent as Record<string, unknown>).message as string
        ).slice("Projects loaded.\n\n".length);
        expect(discoveryGuidance).toContain("unsupported workspace administration");
        expect(discoveryGuidance).toContain("https://scry.giize.com/support");
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();
        const context = await client.callTool({
          name: "get_testing_context",
          arguments: { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        });
        expect(context.isError).not.toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const instructions = (context.structuredContent as Record<string, unknown>)
          .workflowGuidance as string;
        expect(instructions).toBe(discoveryGuidance);
        if (native)
          expect(instructions).toContain("queues browser observations as durable actions");
        expect(context.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("workflowGuidance"),
            }),
          ]),
        );
        fetcher.mockClear();
        if (native) {
          expect(instructions).toContain(
            "Withheld destinations remain unknown; explain the gap without guessing a blocked host",
          );
          expect(instructions).toContain("Masking alone does not save credentials");
          expect(instructions).toContain("never recover plaintext from pixels or logs");
          // Native wording is intentionally compact. Assert the safety decisions
          // and executable protocol instead of freezing paragraphs of old prose.
          for (const fact of [
            "application verdict",
            "safeReport.presentation",
            "not_tested",
            "inconclusive",
            "unknown action may already have happened",
            "Never repeat an uncertain write",
            "Reuse available task facts",
            "client's approval rules",
            "Silence",
            "continue independent checks",
            "unsupported workspace administration",
            "in the same reply",
            "https://scry.giize.com/support",
            "next useful action and who can do it",
            "agreed exclusion",
            "not requested-scenario coverage",
            "never invent references",
          ])
            expect(instructions).toContain(fact);
          expect(Buffer.byteLength(instructions)).toBeLessThan(14300);
          expect(instructions.split("\n\n").length).toBeLessThan(21);
        } else {
          expect(instructions).toContain(
            "Customer reports describe the tested application, not Scry",
          );
          expect(instructions).toContain("safeReport.presentation");
          expect(instructions).toContain("not_tested");
          expect(instructions).toContain("inconclusive");
          expect(instructions).toContain("No automatic retry");
          expect(instructions).toContain("operator diagnostics");
          expect(instructions).toContain(
            "Before asking a question, review the current conversation",
          );
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
          expect(instructions).toContain(
            "If the reason is unknown, say so instead of inventing one",
          );
          expect(instructions).toContain("not automatically confirmed defects");
        }
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
