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

const runtime = window.__SCRY_CONFIG__ ?? {};

export const publicConfig = {
  apiBaseUrl: runtime.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? "/v1",
  mcpServerUrl:
    runtime.mcpServerUrl ?? import.meta.env.VITE_MCP_SERVER_URL ?? `${window.location.origin}/mcp`,
  supabaseUrl: runtime.supabaseUrl ?? import.meta.env.VITE_SUPABASE_URL,
  supabasePublishableKey:
    runtime.supabasePublishableKey ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
};

export {};
