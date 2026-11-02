import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/@remix-run")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "icons";
          }
          if (id.includes("node_modules/@supabase")) {
            return "supabase";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/mcp": {
        target: process.env.VITE_MCP_PROXY_TARGET ?? "http://127.0.0.1:4100",
        changeOrigin: false,
      },
      "/.well-known/oauth-protected-resource": {
        target: process.env.VITE_MCP_PROXY_TARGET ?? "http://127.0.0.1:4100",
        changeOrigin: false,
      },
      "/oauth": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
        changeOrigin: false,
      },
      "/.well-known": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
        changeOrigin: false,
      },
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
        changeOrigin: false,
      },
    },
  },
});
