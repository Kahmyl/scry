import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { scopedRequestSchema, verifyDownloadSchema } from "@scry/contracts";
// @ts-expect-error Private runtime modules are characterized through their public facts.
import { allowedAddress, scopedHttp as executeHttp } from "../src/mcp-native/scoped-http.mjs";
// @ts-expect-error Private runtime module.
import { DownloadTracker } from "../src/mcp-native/downloads.mjs";
// @ts-expect-error Private runtime module.
import { MaskingDiagnostics } from "../src/mcp-native/masking-diagnostics.mjs";
// @ts-expect-error Private runtime module.
import { BestEffortTasks } from "../src/mcp-native/best-effort-tasks.mjs";
let origin: string,
  server: ReturnType<typeof createServer>,
  effects = 0;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/hang") {
      effects++;
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/private" });
      res.end();
      return;
    }
    if (req.url === "/big") {
      res.setHeader("content-type", "application/json");
      res.end('"' + "x".repeat(2000) + '"');
      return;
    }
    if (req.url === "/cut") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
      res.write("prefix");
      setTimeout(() => res.destroy(), 10);
      return;
    }
    if (req.url === "/gzip") {
      res.setHeader("content-encoding", "gzip");
      res.end("opaque");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.statusCode = req.url === "/unauthorized" ? 401 : 200;
    res.end(
      JSON.stringify({
        host: req.headers.host,
        auth: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
        ok: true,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + (server.address() as any).port;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
const input = (path = "/", more: Record<string, unknown> = {}) =>
  scopedRequestSchema.parse({ method: "GET", url: origin + path, ...more });
const policy = () => ({ allowedOrigins: [origin], privateOrigins: [origin] });
// Model the private binding adapter: public arguments contain references only;
// resolved values arrive separately from the authorized command owner.
function scopedHttp(input: any, policy: any, bindings: any[] = []) {
  const cid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const privateBindings = bindings.map((b) => ({
    ...b,
    protectedValueId: b.protectedValueId ?? cid,
    ...(b.header ? { format: b.format ?? "raw" } : {}),
  }));
  return executeHttp(
    {
      ...input,
      credentials: privateBindings.filter((b) => b.header).map(({ value, ...b }) => b),
      bodyBindings: privateBindings.filter((b) => b.path).map(({ value, ...b }) => b),
    },
    policy,
    privateBindings,
  );
}
it("requires every public credential reference to have an exact private owner binding", async () => {
  const request = input("/", {
    credentials: [
      {
        protectedValueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        header: "authorization",
        format: "bearer",
      },
    ],
  });
  expect((await executeHttp(request, policy(), [])).reason).toBe("credential_binding_unavailable");
  expect(
    (
      await executeHttp(request, policy(), [
        {
          protectedValueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          header: "authorization",
          format: "bearer",
          value: "secret",
        },
      ])
    ).execution,
  ).toBe("not_dispatched");
});
it.each([
  "0.0.0.0",
  "127.0.0.1",
  "127.1.2.3",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.100.100.200",
  "100.64.0.1",
  "168.63.129.16",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:169.254.169.254",
  "fd00:ec2::254",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "64:ff9b::7f00:1",
  "2001:db8::1",
  "2002:7f00:1::1",
  "2001::1",
])("rejects a non-public network destination %s", (address) =>
  expect(allowedAddress(address)).toBe(false),
);
it.each([
  "169.254.169.254",
  "100.100.100.200",
  "168.63.129.16",
  "fd00:ec2::254",
  "::ffff:169.254.169.254",
  "ff02::1",
])("operator private-origin permission never opens metadata/multicast %s", (address) =>
  expect(allowedAddress(address, true)).toBe(false),
);
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("accepts a public address %s", (address) =>
  expect(allowedAddress(address)).toBe(true),
);
it("requires an operator-approved private origin in addition to Environment scope", async () => {
  expect((await scopedHttp(input(), { allowedOrigins: [origin] })).reason).toBe(
    "network_destination_denied",
  );
  expect((await scopedHttp(input(), policy())).status).toBe(200);
});
it.each([
  "file:///etc/passwd",
  "http://169.254.169.254/",
  "http://outside.example/",
  "http://user:password@127.0.0.1/",
  "http://127.0.0.1/#secret",
])("refuses an out-of-scope/ambiguous URL before dispatch %s", async (url) =>
  expect((await scopedHttp(input("/", { url }), policy())).execution).toBe("not_dispatched"),
);
it("validates every DNS answer and pins one resolved address without a second lookup", async () => {
  const port = new URL(origin).port,
    url = `http://fixture.example:${port}/`,
    resolve = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
  const r = await scopedHttp(input("/", { url }), {
    allowedOrigins: [new URL(url).origin],
    privateOrigins: [new URL(url).origin],
    resolve,
  });
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body).host).toBe(`fixture.example:${port}`);
  expect(resolve).toHaveBeenCalledTimes(1);
  const denied = await scopedHttp(input("/", { url: "https://fixture.example/" }), {
    allowedOrigins: ["https://fixture.example"],
    resolve: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  expect(denied.reason).toBe("network_destination_denied");
});
it("does not follow a redirect or send credentials to its destination", async () => {
  const r = await scopedHttp(input("/redirect"), policy(), [
    { header: "authorization", format: "bearer", value: "fictional-private-key" },
  ]);
  expect(r).toMatchObject({ status: 302, reason: "redirect_not_followed", bodyOmitted: true });
});
it("injects explicitly bound credentials/body fields privately and retains HTTP failure status", async () => {
  const r = await scopedHttp(
    input("/unauthorized", { method: "POST", body: { name: "fixture" } }),
    policy(),
    [
      { header: "authorization", format: "bearer", value: "fictional-api-secret" },
      { path: ["account", "password"], value: "fictional-password" },
    ],
  );
  expect(r.status).toBe(401);
  expect(JSON.parse(r.body)).toMatchObject({
    auth: "Bearer fictional-api-secret",
    body: { name: "fixture", account: { password: "fictional-password" } },
  });
});
it.each(["/big", "/cut", "/gzip"])(
  "never returns a truncated/unverifiable response body for %s",
  async (path) => {
    const r = await scopedHttp(input(path, { maxResponseBytes: 100 }), policy());
    expect(r.execution).toBe("unknown");
    expect(r.bodyOmitted).toBe(true);
    expect(r.body).toBeUndefined();
  },
);
it("times out a dispatched write once and preserves uncertainty", async () => {
  const before = effects,
    r = await scopedHttp(input("/hang", { method: "POST", timeoutMs: 120 }), policy());
  expect(r.execution).toBe("unknown");
  expect(r.reason).toBe("request_deadline");
  expect(effects - before).toBe(1);
});
it("a stalled DNS lookup is bounded and never dispatched", async () => {
  const before = performance.now(),
    r = await scopedHttp(input("/", { url: "https://fixture.example/", timeoutMs: 100 }), {
      allowedOrigins: ["https://fixture.example"],
      resolve: () => new Promise(() => {}),
    });
  expect(r.execution).toBe("not_dispatched");
  expect(performance.now() - before).toBeLessThan(1000);
});
it("refuses unbound URL secrets, conflicting body bindings and newline credentials", async () => {
  expect((await scopedHttp(input("/?access_token=private"), policy())).reason).toBe(
    "url_secret_reference_required",
  );
  expect(
    (
      await scopedHttp(input("/", { method: "POST", body: { a: "existing" } }), policy(), [
        { path: ["a"], value: "secret" },
      ])
    ).reason,
  ).toBe("body_binding_conflict");
  expect(
    (
      await scopedHttp(input(), policy(), [
        { header: "authorization", value: "secret\r\nHost: other" },
      ])
    ).reason,
  ).toBe("credential_unusable");
});
function download(bytes: Buffer, failure: string | null = null) {
  return {
    createReadStream: vi.fn(async () => Readable.from([bytes])),
    failure: vi.fn(async () => failure),
    suggestedFilename: () => "fixture.json",
    delete: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
}
it("a late stream cannot turn a timed-out download into verified completion", async () => {
  vi.useFakeTimers();
  let release!: (value: ReturnType<typeof Readable.from>) => void;
  const tracker = new DownloadTracker((s: string) => s),
    d = download(Buffer.from("{}"));
  d.createReadStream.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    tracker.capture(d);
    await vi.advanceTimersByTimeAsync(30001);
    expect(tracker.list()[0].state).toBe("timed_out");
    release(Readable.from([Buffer.from("{}")]));
    await tracker.items.values().next().value.done;
    expect(tracker.list()[0].state).toBe("timed_out");
    expect(
      tracker.verify(tracker.list()[0].id, { minBytes: 0, maxBytes: 100, format: "json" }).verified,
    ).toBe(false);
    expect(d.delete).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("verifies completed bytes/hash/format and exposes no content or private path", async () => {
  const tracker = new DownloadTracker((s: string) => s),
    bytes = Buffer.from('{"ok":true}'),
    d = download(bytes);
  tracker.capture(d);
  await tracker.items.values().next().value.done;
  const item = tracker.list()[0],
    expected = verifyDownloadSchema.parse({
      downloadId: item.id,
      expected: { sha256: createHash("sha256").update(bytes).digest("hex"), format: "json" },
    }).expected;
  expect(tracker.verify(item.id, expected).verified).toBe(true);
  expect(JSON.stringify(tracker.list())).not.toContain('"ok"');
  expect(d.delete).toHaveBeenCalledOnce();
  expect(
    tracker.verify(item.id, {
      ...expected,
      sha256: "0".repeat(64),
      fileName: "other",
      format: "pdf",
      minBytes: 999,
    }).mismatches,
  ).toEqual(["size", "sha256", "filename", "format"]);
});
it.each(["interrupted", "oversized", "invalid_json"])(
  "does not claim a valid completed expected download for %s",
  async (mode) => {
    const tracker = new DownloadTracker((s: string) => s, { maxBytes: 100 }),
      d = download(
        Buffer.from(mode === "oversized" ? "x".repeat(101) : "not json"),
        mode === "interrupted" ? "failed" : null,
      );
    tracker.capture(d);
    await tracker.items.values().next().value.done;
    const item = tracker.list()[0];
    expect(tracker.verify(item.id, { minBytes: 1, maxBytes: 100, format: "json" }).verified).toBe(
      false,
    );
    expect(d.delete).toHaveBeenCalledOnce();
  },
);
it("enforces a finite Session download count and retains pending versus missing facts", async () => {
  const tracker = new DownloadTracker((s: string) => s, { limit: 1 });
  const d = download(Buffer.from("{}"));
  tracker.capture(d);
  await tracker.items.values().next().value.done;
  const rejected = download(Buffer.from("{}"));
  tracker.capture(rejected);
  expect(rejected.cancel).toHaveBeenCalledOnce();
  expect(tracker.rejected).toBe(1);
  expect(tracker.verify("unknown", {})).toMatchObject({ verified: false, state: "not_found" });
  await tracker.close();
});
it("records finite masking reasons and recovery, without page contents", async () => {
  const events: any[] = [],
    page = {},
    diagnostics = new MaskingDiagnostics((e: unknown) => events.push(e));
  diagnostics.degrade(page, "installation_pending");
  diagnostics.degrade(page, "installation_pending");
  diagnostics.recovered(page);
  diagnostics.forget(page);
  expect(events.map((e) => [e.state, e.reason])).toEqual([
    ["degraded", "installation_pending"],
    ["recovered", "refresh_confirmed"],
    ["page_closed", "page_closed"],
  ]);
  expect(new Set(events.map((e) => e.pageId)).size).toBe(1);
});
it("a timed-out maintenance task does not enqueue replacements and late success records recovery", async () => {
  const warnings: any[] = [],
    recovered: any[] = [],
    key = {},
    work = vi.fn();
  let finish!: () => void;
  work.mockReturnValue(new Promise<void>((r) => (finish = r)));
  const tasks = new BestEffortTasks(
    (...v: any[]) => warnings.push(v),
    10,
    (v: unknown) => recovered.push(v),
  );
  await tasks.run([[key, work]]);
  await tasks.run([[key, work]]);
  expect(work).toHaveBeenCalledOnce();
  expect(warnings[0][0]).toBe("maintenance_timeout");
  finish();
  await new Promise((r) => setTimeout(r, 0));
  expect(recovered).toEqual([key]);
});
it("maintenance rejection and success remain distinct", async () => {
  const warn = vi.fn(),
    recovered = vi.fn(),
    tasks = new BestEffortTasks(warn, 100, recovered);
  await tasks.run([
    [
      {},
      async () => {
        throw Error("private diagnostic must not escape");
      },
    ],
  ]);
  expect(warn.mock.calls[0]![0]).toBe("maintenance_failed");
  expect(recovered).not.toHaveBeenCalled();
});
it("requests cancellation on reported capacity without claiming transfer or business success", async () => {
  const tracker = new DownloadTracker((s: string) => s, { maxBytes: 100 }),
    cancel = vi.fn(async () => {});
  tracker.progress(
    { guid: "fictional-guid", receivedBytes: 5, totalBytes: 101, state: "inProgress" },
    cancel,
  );
  tracker.progress(
    { guid: "fictional-guid", receivedBytes: 10, totalBytes: 101, state: "inProgress" },
    cancel,
  );
  expect(cancel).toHaveBeenCalledExactlyOnceWith("fictional-guid");
  expect(tracker.capacityCancellationRequests).toBe(1);
  expect(tracker.list()).toEqual([]);
});
