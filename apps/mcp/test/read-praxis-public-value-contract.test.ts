import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ScryApiClient } from "../src/api-client.js";
import {
  registerReadPraxisPublicValueTool,
} from "../src/tools/adaptive-sessions/read-praxis-public-value.tool.js";

describe(
  "read_praxis_public_value public contract",
  () => {
    it(
      "accepts canonical target provenance including referenceVersion",
      async () => {
        const reference =
          "context-value-0123456789abcdef0123456789abcdef";

        const value = {
          reference,
          classification: "public" as const,
          provenance: {
            referenceVersion: 1 as const,
            pageId: "page-1",
            frameId: "frame-1",
            documentEpoch: 0,
            documentIdentity:
              "https://preview.example.test/api/docs",
          },
          element: {
            kind: "code" as const,
            context: "Create Order",
          },
          text: "/api/v1/partner/orders",
          offset: 0,
          returnedBytes: 22,
          totalBytes: 22,
          truncated: false,
          admission: {
            admissionRevision: 1,
            contentDigest:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            admissionDigest:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        };

        const post = vi
          .fn()
          .mockResolvedValue(value);

        const apiClient = {
          post,
        } as unknown as ScryApiClient;

        const server = new McpServer({
          name: "public-value-contract-test",
          version: "1.0.0",
        });

        const client = new Client({
          name: "public-value-contract-client",
          version: "1.0.0",
        });

        const [
          clientTransport,
          serverTransport,
        ] =
          InMemoryTransport.createLinkedPair();

        try {
          registerReadPraxisPublicValueTool(
            server,
            apiClient,
          );

          await server.connect(
            serverTransport,
          );

          await client.connect(
            clientTransport,
          );

          const response =
            await client.callTool({
              name:
                "read_praxis_public_value",
              arguments: {
                praxisSessionId:
                  randomUUID(),
                reference,
              },
            });

          expect(
            response.isError,
          ).not.toBe(true);

          const structured =
            response.structuredContent as {
              message: string;
              value: typeof value;
            };

          expect(
            structured.value.provenance
              .referenceVersion,
          ).toBe(1);

          expect(
            structured.value.reference,
          ).toBe(reference);

          expect(
            structured.value.text,
          ).toBe(
            "/api/v1/partner/orders",
          );

          expect(post).toHaveBeenCalledTimes(1);
        } finally {
          await client
            .close()
            .catch(() => undefined);

          await server
            .close()
            .catch(() => undefined);
        }
      },
    );
  },
);
