declare global {
  interface Window {
    __SCRY_CONFIG__?: {
      apiBaseUrl?: string;
      mcpServerUrl?: string;
      supabaseUrl?: string;
      supabasePublishableKey?: string;
    };
  }
}

const browserWindow = typeof window === "undefined" ? undefined : window;
const runtime = browserWindow?.__SCRY_CONFIG__ ?? {};

export const publicConfig = {
  apiBaseUrl: runtime.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? "/api",
  mcpServerUrl:
    runtime.mcpServerUrl ??
    import.meta.env.VITE_MCP_SERVER_URL ??
    `${browserWindow?.location.origin ?? ""}/mcp`,
  supabaseUrl: runtime.supabaseUrl ?? import.meta.env.VITE_SUPABASE_URL,
  supabasePublishableKey:
    runtime.supabasePublishableKey ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};

export {};
