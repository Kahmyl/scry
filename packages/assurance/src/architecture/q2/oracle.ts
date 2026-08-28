import { createServer, type Server } from "node:http";

export type DispatchOracle = Readonly<{
  origin: string;
  mutationUrl: string;
  truthUrl: string;
  close(): Promise<void>;
}>;

export async function startDispatchOracle(): Promise<DispatchOracle> {
  const operations = new Map<string, number>();
  const server: Server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/mutation") {
      const operationId = request.headers["idempotency-key"];
      if (typeof operationId !== "string" || !operationId) {
        response.writeHead(400).end();
        return;
      }
      operations.set(operationId, (operations.get(operationId) ?? 0) + 1);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/truth/")) {
      const operationId = decodeURIComponent(request.url.slice("/truth/".length));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ operationId, mutationRequestCount: operations.get(operationId) ?? 0 }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Q2_ORACLE_ADDRESS_UNAVAILABLE");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    mutationUrl: `${origin}/mutation`,
    truthUrl: `${origin}/truth`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
