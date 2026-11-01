import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { originProxy } from "../src/proxy.mjs";
import { Server, RequestError } from "proxy-chain";
const root = "/results/transport-" + Date.now();
await mkdir(root, { recursive: true });
const target = http.createServer((_req, res) => res.end("<h1>Native WebSocket comparison</h1>"));
const targetSockets = new Set();
target.on("connection", (socket) => {
  targetSockets.add(socket);
  socket.on("close", () => targetSockets.delete(socket));
});
target.on("upgrade", (req, socket) => {
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );
  const body = Buffer.from("Native connection works");
  socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
  socket.on("error", () => {});
  socket.on("data", () => {});
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + target.address().port;
const results = [];
for (const implementation of ["candidate", "established"]) {
  let proxy, browser;
  const requests = [];
  try {
    if (implementation === "candidate")
      proxy = await originProxy([origin], (event) => requests.push(event));
    else {
      const server = new Server({
        host: "127.0.0.1",
        port: 0,
        verbose: false,
        prepareRequestFunction: ({ hostname, port, isHttp }) => {
          requests.push({ hostname, port, isHttp });
          if (hostname !== "127.0.0.1" || port !== target.address().port)
            throw new RequestError("Out of scope", 403);
          return {};
        },
      });
      await server.listen();
      proxy = { url: "http://127.0.0.1:" + server.port, close: () => server.close(true) };
    }
    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(origin);
    const result = await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const socket = new WebSocket(url.replace("http:", "ws:") + "/socket");
          socket.onmessage = (e) => {
            socket.close();
            resolve(e.data);
          };
          socket.onerror = () => resolve("WebSocket failed");
          setTimeout(() => resolve("WebSocket timeout"), 3000);
        }),
      origin,
    );
    results.push({ implementation, result, requests });
  } catch (error) {
    results.push({ implementation, error: error.message, requests });
  } finally {
    await browser?.close();
    await proxy?.close();
  }
}
for (const socket of targetSockets) socket.destroy();
await new Promise((resolve) => target.close(resolve));
await writeFile(root + "/results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify({ root, results }));
if (results.some((result) => result.result !== "Native connection works")) process.exitCode = 1;
