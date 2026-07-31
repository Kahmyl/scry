import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const host = process.env.WEB_HOST ?? "0.0.0.0";
const port = Number(process.env.WEB_PORT ?? 3000);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

async function sendFile(filePath, response, cacheControl = "no-cache") {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;
    response.statusCode = 200;
    response.setHeader("content-type", contentTypes.get(path.extname(filePath)) ?? "application/octet-stream");
    response.setHeader("cache-control", cacheControl);
    createReadStream(filePath).pipe(response);
    return true;
  } catch {
    return false;
  }
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (url.pathname === "/config.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`window.__SCRY_CONFIG__=${JSON.stringify({
        apiBaseUrl: process.env.SCRY_PUBLIC_API_BASE_URL ?? "/v1",
        mcpServerUrl: process.env.SCRY_PUBLIC_MCP_SERVER_URL ?? "/mcp",
        supabaseUrl: process.env.SUPABASE_URL ?? "",
        supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
      })};`);
      return;
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = path.resolve(root, relative);
    if (candidate.startsWith(`${root}${path.sep}`) && await sendFile(candidate, response, "public, max-age=31536000, immutable")) return;
    await sendFile(path.join(root, "index.html"), response);
  } catch (error) {
    console.error(error);
    response.writeHead(502, { "content-type": "application/json" });
    response.end('{"message":"Upstream request failed"}');
  }
}).listen(port, host, () => console.log(`Scry web listening on http://${host}:${port}`));
