import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ScryApiClient } from "../src/api-client.js";
import { registerInspectPraxisRegionTool } from "../src/tools/adaptive-sessions/inspect-praxis-region.tool.js";
import { registerReadPraxisPublicValueTool } from "../src/tools/adaptive-sessions/read-praxis-public-value.tool.js";

describe("inspect_praxis_region MCP SDK boundary", () => {
  it("returns only bounded references before read_praxis_public_value releases exact text", async () => {
    const contextControlReference = "context-control-0123456789abcdef0123456789abcdef";
    const valueReference = "context-value-0123456789abcdef0123456789abcdef";
    const exactText = "POST /api/v1/partner-api/orders";
    const inspection = {
      contextControlReference,
      authority: {
        referenceVersion: 1 as const,
        pageId: "page-1",
        frameId: "frame-1",
        documentEpoch: 7,
        documentIdentity: "document-identity-1",
      },
      region: { kind: "section" as const },
      readableValues: [
        {
          reference: valueReference,
          kind: "code" as const,
          classification: "public" as const,
          context: "Create Order",
        },
      ],
      readableValueCompleteness: {
        kind: "bounded" as const,
        observed: 1,
        returned: 1,
        truncated: false,
      },
    };
    const value = {
      reference: valueReference,
      classification: "public" as const,
      provenance: inspection.authority,
      element: { kind: "code" as const, context: "Create Order" },
      text: exactText,
      offset: 0,
      returnedBytes: Buffer.byteLength(exactText),
      totalBytes: Buffer.byteLength(exactText),
      truncated: false,
      admission: {
        admissionRevision: 1,
        contentDigest: "a".repeat(64),
        admissionDigest: "b".repeat(64),
      },
    };
    const post = vi.fn(async (path: string) =>
      path.endsWith("/regions/inspect") ? inspection : value,
    );
    const apiClient = { post } as unknown as ScryApiClient;
    const server = new McpServer({ name: "region-contract-test", version: "1.0.0" });
    const client = new Client({ name: "region-contract-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      registerInspectPraxisRegionTool(server, apiClient);
      registerReadPraxisPublicValueTool(server, apiClient);
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const inspected = await client.callTool({
        name: "inspect_praxis_region",
        arguments: { praxisSessionId: randomUUID(), contextControlReference },
      });
      expect(inspected.isError).not.toBe(true);
      const inspectStructured = inspected.structuredContent as {
        inspection: typeof inspection;
      };
      expect(inspectStructured.inspection.readableValues[0]?.reference).toBe(valueReference);
      expect(JSON.stringify(inspectStructured)).not.toContain(exactText);
      expect(inspectStructured.inspection).not.toHaveProperty("text");

      const read = await client.callTool({
        name: "read_praxis_public_value",
        arguments: { praxisSessionId: randomUUID(), reference: valueReference },
      });
      expect(read.isError).not.toBe(true);
      expect((read.structuredContent as { value: typeof value }).value.text).toBe(exactText);
      expect(post).toHaveBeenCalledTimes(2);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
