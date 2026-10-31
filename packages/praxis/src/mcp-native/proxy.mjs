import { Server, RequestError } from "proxy-chain";

// HTTP requests are checked by origin. CONNECT is an opaque TCP tunnel (used
// by Chromium for BOTH HTTPS and plain WebSockets), so it is checked against
// explicitly approved host/port endpoints, without decrypting application TLS.
export async function originProxy(origins, onBlocked = () => {}) {
  const urls = origins.map((value) => new URL(value));
  if (
    urls.some((url) => !["http:", "https:"].includes(url.protocol) || url.username || url.password)
  )
    throw new Error("INVALID_ENVIRONMENT_ORIGIN");
  const allowedOrigins = new Set(urls.map((url) => url.origin));
  const endpoint = (host, port) =>
    (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host) + ":" + port;
  const allowedEndpoints = new Set(
    urls.map((url) =>
      endpoint(url.hostname, Number(url.port) || (url.protocol === "https:" ? 443 : 80)),
    ),
  );
  const server = new Server({
    host: "127.0.0.1",
    port: 0,
    verbose: false,
    prepareRequestFunction: ({ request, hostname, port, isHttp }) => {
      const origin = isHttp ? new URL(request.url).origin : "tunnel://" + hostname + ":" + port;
      const allowed = isHttp
        ? allowedOrigins.has(origin)
        : allowedEndpoints.has(endpoint(hostname, port));
      if (!allowed) {
        onBlocked({ origin, reason: "origin_not_allowed" });
        throw new RequestError("Out of the authorized test scope", 403);
      }
      return {};
    },
  });
  server.on("requestFailed", () => {}); // No raw URLs/headers/credentials in logs.
  await server.listen();
  return { url: "http://127.0.0.1:" + server.port, close: () => server.close(true) };
}
