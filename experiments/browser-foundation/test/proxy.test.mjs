import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { originProxy } from "../src/proxy.mjs";
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", r));
const close = (server) => new Promise((r) => server.close(r));
const request = (proxy, url, method = "GET") =>
  new Promise((resolve, reject) => {
    const req = http.request(proxy, { path: url, method }, (res) => {
      let body = "";
      res.on("data", (b) => (body += b));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "fictional" : undefined);
  });
test("CONNECT permits an approved HTTP endpoint for Chromium WebSockets, rejects other endpoints", async () => {
  let hits = 0;
  const target = net.createServer((socket) => {
    hits++;
    socket.end("approved endpoint");
  });
  await listen(target);
  const origin = "http://127.0.0.1:" + target.address().port;
  const proxy = await originProxy([origin]);
  const connect = (authority) =>
    new Promise((resolve, reject) => {
      const p = new URL(proxy.url);
      const socket = net.connect(Number(p.port), p.hostname, () =>
        socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n"),
      );
      let output = "";
      socket.on("data", (b) => (output += b));
      socket.on("end", () => resolve(output));
      socket.on("error", reject);
    });
  try {
    assert.match(await connect("127.0.0.1:1"), /403/);
    assert.equal(hits, 0);
    assert.match(await connect("127.0.0.1:" + target.address().port), /approved endpoint/);
    assert.equal(hits, 1);
  } finally {
    await proxy.close();
    await close(target);
  }
});
test("origin proxy permits multiple POSTs and GET resources, blocks other origins before dispatch", async () => {
  let hits = 0;
  const target = http.createServer((req, res) => {
    hits++;
    res.end("ok");
  });
  await listen(target);
  const origin = "http://127.0.0.1:" + target.address().port,
    blocked = [];
  const proxy = await originProxy([origin], (e) => blocked.push(e));
  try {
    assert.equal((await request(proxy.url, origin + "/read", "POST")).status, 200);
    assert.equal((await request(proxy.url, origin + "/save", "POST")).status, 200);
    assert.equal((await request(proxy.url, origin + "/image")).status, 200);
    assert.equal((await request(proxy.url, "http://127.0.0.1:1/denied")).status, 403);
    assert.equal(hits, 3);
    assert.equal(blocked.length, 1);
  } finally {
    await proxy.close();
    await close(target);
  }
});
test("CONNECT scope is checked before opening a tunnel", async () => {
  let hits = 0;
  const target = net.createServer((s) => {
    hits++;
    s.end("tunnel");
  });
  await listen(target);
  const proxy = await originProxy(["https://127.0.0.1:" + target.address().port]);
  const connect = (authority) =>
    new Promise((resolve, reject) => {
      const url = new URL(proxy.url);
      const c = net.connect(Number(url.port), url.hostname, () =>
        c.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n"),
      );
      let data = "";
      c.on("data", (b) => (data += b));
      c.on("end", () => resolve(data));
      c.on("error", reject);
    });
  try {
    assert.match(await connect("127.0.0.1:1"), /403/);
    assert.equal(hits, 0);
    assert.match(await connect("127.0.0.1:" + target.address().port), /200 Connection Established/);
    assert.equal(hits, 1);
  } finally {
    await proxy.close();
    await close(target);
  }
});
