// Local qualification transport only. Reuse the running fixture's identity issuer;
// stream authenticated media directly rather than its 8 MiB HTML-fixture buffer.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1:45492");
    if (url.pathname === "/config.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(
        `window.__SCRY_CONFIG__=${JSON.stringify({
          apiBaseUrl: "/api",
          supabaseUrl: "http://127.0.0.1:45492",
          supabasePublishableKey: "isolated-fixture-only",
          mcpServerUrl: "/mcp",
        })};`,
      );
      return;
    }
    const media = /^\/api\/runs\/[a-f0-9-]+\/media\/\d+$/u.test(url.pathname);
    const target =
      (media ? "http://127.0.0.1:45400" : "http://127.0.0.1:45491") + url.pathname + url.search;
    const headers = {};
    for (const key of ["authorization", "content-type", "range"])
      if (request.headers[key]) headers[key] = request.headers[key];
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(!["GET", "HEAD"].includes(request.method) ? { body: request, duplex: "half" } : {}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
    });
    response.statusCode = upstream.status;
    for (const key of ["content-type", "content-range", "accept-ranges", "cache-control"])
      if (upstream.headers.has(key)) response.setHeader(key, upstream.headers.get(key));
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end('{"message":"isolated_streaming_review_unavailable"}');
  }
}).listen(45492, "127.0.0.1", () => console.log("Blind review bridge: http://127.0.0.1:45492"));
