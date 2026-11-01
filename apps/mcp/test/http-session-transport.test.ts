import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("MCP Streamable HTTP session authority", () => {
  it("uses explicit stateful sessions rather than a per-request no-option transport", async () => {
    const source = await readFile(new URL("../src/http.ts", import.meta.url), "utf8");

    expect(source).toContain("sessionIdGenerator: () => randomUUID()");

    expect(source).toContain("enableJsonResponse: true");

    expect(source).toContain('request.headers["mcp-session-id"]');

    expect(source).toContain("sessions.get");

    expect(source).toContain("sessions.set");

    expect(source).toContain("tokenDigest");

    expect(source).toContain('["POST", "GET", "DELETE"]');

    expect(source).not.toContain("new StreamableHTTPServerTransport();");

    expect(source).not.toContain("This stateless MCP endpoint accepts POST requests.");

    expect(source).not.toContain('response.on("close"');
  });
});
