import { BrowserApiError } from "./api-client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const browserErrorEnvelopeCapability = "scry.errorEnvelope";

/** Errors use an explicit versioned envelope with the same safe text fallback.
 * Do not serialize .code, .safeActions, .cause or arbitrary provider errors.
 */
export async function browserToolCall<T>(
  server: McpServer,
  call: () => Promise<T>,
): Promise<
  | T
  | {
      isError: true;
      content: Array<{ type: "text"; text: string }>;
      structuredContent?: {
        message: string;
        interaction: BrowserApiError["interaction"];
        error: Record<string, unknown>;
      };
    }
> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof BrowserApiError)) throw error;
    const structuredContent = {
      message: error.interaction.summary,
      interaction: error.interaction,
      error: error.publicDetail,
    };
    // SDK clients may validate even error structuredContent against cached
    // success-only schemas. A client must explicitly admit the versioned error
    // envelope; old clients retain the exact same typed JSON in text instead.
    const capability =
      server.server.getClientCapabilities()?.experimental?.[browserErrorEnvelopeCapability];
    const negotiated =
      capability !== null &&
      typeof capability === "object" &&
      !Array.isArray(capability) &&
      Object.keys(capability).length === 1 &&
      (capability as Record<string, unknown>).version === 1;
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      ...(negotiated ? { structuredContent } : {}),
    };
  }
}
