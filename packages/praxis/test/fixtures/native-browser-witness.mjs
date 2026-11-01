import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

// Independent fixture observer, never a production capture or authority path.
const metrics = new BigInt64Array(workerData.metrics);
const server = createServer((request, response) => {
  if (request.url === "/tick") {
    Atomics.add(metrics, 0, 1n);
    Atomics.store(metrics, 1, BigInt(Date.now()));
    response.writeHead(204, { "cache-control": "no-store" }).end();
  } else {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(
      "<title>Independent live browser witness</title><script>setInterval(()=>fetch('/tick').catch(()=>{}),20)</script><main>Fixture</main>",
    );
  }
});
server.listen(0, "127.0.0.1", () => {
  parentPort.postMessage({ origin: `http://127.0.0.1:${server.address().port}` });
});
parentPort.on("message", () => {
  server.closeAllConnections();
  server.close(() => parentPort.close());
});
