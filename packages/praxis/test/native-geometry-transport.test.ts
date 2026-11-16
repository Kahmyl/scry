import { chromium, type CDPSession } from "playwright";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transportNativeGeometry } from "../src/mcp-native/geometry-transport.mjs";

const scope = { instanceId: "installed-graph", graphId: "built-graph" };
const rect = (left = 20, top = 30, width = 90, height = 25) => [
  left,
  top,
  left + width,
  top,
  left + width,
  top + height,
  left,
  top + height,
];
const request = (token = "owner-one") => ({
  token,
  pseudo: "after",
  localBox: { left: 10, top: 15, width: 120, height: 35 },
});
function fixture() {
  const ticket = {
    version: 1,
    nonce: "attempt-nonce",
    readId: 7,
    policyGeneration: 3,
    revision: 2,
    scope,
    requests: [request()],
  };
  const calls: {
    method: string;
    params: Record<string, unknown>;
    action?: string;
    args?: unknown[];
  }[] = [];
  const handlers = new Map<string, (params: Record<string, unknown>, args: unknown[]) => unknown>();
  let current = true;
  const controller = new AbortController();
  const accepted: unknown[][] = [];
  const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const parsed =
      typeof params.expression === "string"
        ? /^globalThis\.__scryNativeGraph\?\.(\w+)\((.*)\)$/.exec(params.expression)
        : null;
    const action = parsed?.[1],
      args = parsed?.[2] ? (JSON.parse(`[${parsed[2]}]`) as unknown[]) : [];
    calls.push({ method, params, ...(action ? { action } : {}), args });
    const override = handlers.get(action ?? method);
    if (override) return override(params, args);
    if (action === "geometryRequest") return { result: { value: ticket } };
    if (action === "geometryOwner") return { result: { subtype: "node", objectId: "old-owner" } };
    if (action === "geometryAccept") {
      accepted.push(args);
      return { result: { value: { accepted: ticket.requests.length } } };
    }
    if (method === "DOM.describeNode")
      return {
        node: {
          attributes: ["data-private", "DO_NOT_EXPORT_DESCRIPTION"],
          pseudoElements: [
            { pseudoType: "before", backendNodeId: 11 },
            { pseudoType: "after", backendNodeId: 12 },
          ],
        },
      };
    if (method === "DOM.getContentQuads") return { quads: [rect()] };
    if (method === "DOM.getBoxModel") return { model: { border: rect(110, 215, 120, 35) } };
    return {};
  });
  const options = {
    session: { send } as unknown as CDPSession,
    contextId: 1,
    frameId: "frame-one",
    isMainFrame: true,
    readId: 7,
    policyGeneration: 3,
    expectedScope: scope,
    deadline: Date.now() + 200,
    isCurrent: () => current,
    signal: controller.signal,
  };
  return {
    ticket,
    calls,
    handlers,
    accepted,
    send,
    options,
    controller,
    invalidate: () => {
      current = false;
    },
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("retains the finite unsupported reason in the exact graph abort receipt", async () => {
  const f = fixture();
  f.handlers.set("DOM.getContentQuads", () => ({ quads: [] }));
  expect((await transportNativeGeometry(f.options)).reason).toBe(
    "native_protection_geometry_unsupported",
  );
  expect(f.calls.find((call) => call.action === "geometryAbort")?.args).toEqual([
    f.ticket,
    "native_protection_geometry_unsupported",
  ]);
});

it("selects only the exact graph-owned pseudo and keeps all facts private", async () => {
  const f = fixture();
  expect(await transportNativeGeometry(f.options)).toEqual({ ok: true, requests: 1, quads: 1 });
  expect(f.calls.find((call) => call.action === "geometryRequest")?.args).toEqual([7, 200, scope]);
  expect(f.calls.find((call) => call.method === "DOM.describeNode")?.params).toEqual({
    objectId: "old-owner",
    depth: 0,
    pierce: false,
  });
  expect(f.calls.find((call) => call.method === "DOM.getContentQuads")?.params).toEqual({
    backendNodeId: 12,
  });
  expect(f.accepted[0]?.[1]).toEqual([{ token: "owner-one", pseudo: "after", quads: [rect()] }]);
  expect(f.calls.some((call) => call.method === "DOM.getBoxModel")).toBe(false);
  expect(f.calls.some((call) => /querySelector|Snapshot|Search/.test(call.method))).toBe(false);
  expect(f.calls.filter((call) => call.method === "Runtime.releaseObjectGroup")).toHaveLength(1);
});

it("converts translated child-frame coordinates into the exact graph's local space", async () => {
  const f = fixture();
  f.options.isMainFrame = false;
  f.handlers.set("DOM.getContentQuads", () => ({ quads: [rect(120, 230)] }));
  expect(await transportNativeGeometry(f.options)).toEqual({ ok: true, requests: 1, quads: 1 });
  expect(f.accepted[0]?.[1]).toEqual([
    { token: "owner-one", pseudo: "after", quads: [rect(20, 30)] },
  ]);
});

it("refuses parent-frame movement during child quad acquisition", async () => {
  const f = fixture();
  f.options.isMainFrame = false;
  let measured = 0;
  f.handlers.set("DOM.getBoxModel", () => ({
    model: { border: rect(++measured === 1 ? 110 : 150, 215, 120, 35) },
  }));
  expect(await transportNativeGeometry(f.options)).toMatchObject({
    ok: false,
    reason: "native_protection_geometry_stale",
  });
  expect(f.accepted).toHaveLength(0);
});

it.each([
  ["scaled", rect(110, 215, 240, 70)],
  ["rotated", [110, 215, 210, 225, 200, 260, 100, 250]],
  ["mirrored", [230, 215, 110, 215, 110, 250, 230, 250]],
  ["nonfinite", [110, 215, Infinity, 215, 230, 250, 110, 250]],
])("refuses a %s child-frame conversion", async (_, border) => {
  const f = fixture();
  f.options.isMainFrame = false;
  f.handlers.set("DOM.getBoxModel", () => ({ model: { border } }));
  expect(await transportNativeGeometry(f.options)).toMatchObject({
    ok: false,
    reason: "native_protection_geometry_unsupported",
  });
  expect(f.accepted).toHaveLength(0);
});

it.each([
  ["foreign read", { readId: 8 }],
  ["foreign policy", { policyGeneration: 4 }],
  ["foreign graph", { scope: { ...scope, graphId: "replacement" } }],
  ["missing nonce", { nonce: "" }],
  ["bad revision", { revision: NaN }],
  ["wrong version", { version: 2 }],
  ["unknown refusal", { reason: "PRIVATE_PROVIDER_TEXT" }],
])("rejects %s ticket metadata without aborting an untrusted ticket", async (_, change) => {
  const f = fixture();
  f.handlers.set("geometryRequest", () => ({ result: { value: { ...f.ticket, ...change } } }));
  const result = await transportNativeGeometry(f.options);
  expect(result).toEqual({
    ok: false,
    reason: "native_protection_geometry_unsupported",
    requests: 0,
    quads: 0,
  });
  expect(f.calls.some((call) => call.action === "geometryAbort")).toBe(false);
  expect(f.calls.some((call) => call.action === "geometryOwner")).toBe(false);
});

it.each([
  ["duplicate owner", [request(), request()]],
  ["invalid pseudo", [{ ...request(), pseudo: "marker" }]],
  ["unbounded box", [{ ...request(), localBox: { left: 0, top: 0, width: Infinity, height: 1 } }]],
  ["empty box", [{ ...request(), localBox: { left: 0, top: 0, width: 0, height: 1 } }]],
])("refuses %s before acquiring DOM objects", async (_, requests) => {
  const f = fixture();
  f.handlers.set("geometryRequest", () => ({ result: { value: { ...f.ticket, requests } } }));
  expect(await transportNativeGeometry(f.options)).toMatchObject({ ok: false });
  expect(f.calls.some((call) => call.action === "geometryOwner")).toBe(false);
  expect(f.calls.filter((call) => call.action === "geometryAbort")).toHaveLength(1);
});

it.each(["missing", "ambiguous"])(
  "refuses %s matching pseudo instead of choosing another",
  async (which) => {
    const f = fixture();
    f.handlers.set("DOM.describeNode", () => ({
      node: {
        pseudoElements:
          which === "missing"
            ? [{ pseudoType: "before", backendNodeId: 11 }]
            : [
                { pseudoType: "after", backendNodeId: 12 },
                { pseudoType: "after", backendNodeId: 13 },
              ],
      },
    }));
    expect(await transportNativeGeometry(f.options)).toMatchObject({ ok: false });
    expect(f.accepted).toHaveLength(0);
  },
);

it.each(
  [[], [rect().slice(1)], [[0, 0, 20, 2, 20, 20, 0, 20]], [[0, 0, NaN, 0, 20, 20, 0, 20]]].map(
    (quads) => ({ quads }),
  ),
)("refuses missing, malformed or non-axis-aligned paint geometry %#", async ({ quads }) => {
  const f = fixture();
  f.handlers.set("DOM.getContentQuads", () => ({ quads }));
  expect(await transportNativeGeometry(f.options)).toMatchObject({ ok: false });
  expect(f.accepted).toHaveLength(0);
});

it.each(["owners", "owner-quads", "total-quads"])(
  "enforces the %s capacity boundary",
  async (limit) => {
    const f = fixture();
    const count = limit === "owners" ? 65 : limit === "total-quads" ? 17 : 1;
    f.ticket.requests = Array.from({ length: count }, (_, i) => request("owner-" + i));
    f.handlers.set("DOM.getContentQuads", () => ({
      quads: Array.from({ length: limit === "owner-quads" ? 129 : 128 }, () => rect()),
    }));
    expect(await transportNativeGeometry(f.options)).toMatchObject({
      ok: false,
      reason: "native_protection_graph_capacity",
    });
    expect(f.accepted).toHaveLength(0);
  },
);

it("accepts exact capacity without widening admission", async () => {
  const f = fixture();
  f.ticket.requests = Array.from({ length: 64 }, (_, i) => request("owner-" + i));
  f.handlers.set("DOM.getContentQuads", () => ({
    quads: Array.from({ length: 32 }, () => rect()),
  }));
  expect(await transportNativeGeometry(f.options)).toEqual({ ok: true, requests: 64, quads: 2048 });
});

it.each([
  "geometryRequest",
  "geometryOwner",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "geometryAccept",
])("bounds a permanently pending %s and never admits late facts", async (stage) => {
  const f = fixture();
  f.options.isMainFrame = false;
  f.handlers.set(stage, () => new Promise(() => {}));
  const work = transportNativeGeometry(f.options);
  await vi.advanceTimersByTimeAsync(200);
  expect(await work).toMatchObject({ ok: false, reason: "native_protection_geometry_stale" });
  expect(f.calls.filter((call) => call.method === "Runtime.releaseObjectGroup")).toHaveLength(1);
});

it.each([
  "geometryRequest",
  "geometryOwner",
  "DOM.describeNode",
  "DOM.getContentQuads",
  "geometryAccept",
])("fences a replaced read after %s", async (stage) => {
  const f = fixture();
  f.handlers.set(stage, () => {
    f.invalidate();
    return {};
  });
  expect(await transportNativeGeometry(f.options)).toMatchObject({
    ok: false,
    reason: "native_protection_geometry_stale",
  });
  expect(f.calls.filter((call) => call.method === "Runtime.releaseObjectGroup")).toHaveLength(1);
});

it("does not acquire geometry for an already cancelled read", async () => {
  const f = fixture();
  f.controller.abort();
  expect(await transportNativeGeometry(f.options)).toMatchObject({
    ok: false,
    reason: "native_protection_geometry_stale",
  });
  expect(f.calls.some((call) => call.action === "geometryRequest")).toBe(false);
});

it("cancels promptly while the provider is stuck", async () => {
  const f = fixture();
  f.handlers.set("DOM.describeNode", () => new Promise(() => {}));
  const work = transportNativeGeometry(f.options);
  await flush();
  f.controller.abort();
  expect(await work).toMatchObject({ ok: false, reason: "native_protection_geometry_stale" });
});

it("late old-context owner replies cannot release a newer attempt's group", async () => {
  const old = fixture(),
    late = deferred<unknown>();
  old.handlers.set("geometryOwner", () => late.promise);
  const work = transportNativeGeometry(old.options);
  await vi.advanceTimersByTimeAsync(200);
  expect(await work).toMatchObject({ ok: false });
  const fresh = fixture();
  fresh.handlers.set("geometryOwner", () => ({
    result: { subtype: "node", objectId: "new-owner" },
  }));
  expect(await transportNativeGeometry(fresh.options)).toMatchObject({ ok: true });
  late.resolve({ result: { subtype: "node", objectId: "late-old-owner" } });
  await flush();
  const oldGroups = old.calls.filter((call) => call.method === "Runtime.releaseObjectGroup");
  const freshGroups = fresh.calls.filter((call) => call.method === "Runtime.releaseObjectGroup");
  expect(oldGroups).toHaveLength(1);
  expect(oldGroups[0]?.params.objectGroup).not.toBe(freshGroups[0]?.params.objectGroup);
  expect(
    old.calls
      .filter((call) => call.method === "Runtime.releaseObject")
      .map((call) => call.params.objectId),
  ).toEqual(["late-old-owner"]);
  expect(
    fresh.calls
      .filter((call) => call.method === "Runtime.releaseObject")
      .map((call) => call.params.objectId),
  ).toEqual(["new-owner"]);
});

it("ignores an unvalidated late request reply instead of aborting a newer graph", async () => {
  const f = fixture(),
    late = deferred<unknown>();
  f.handlers.set("geometryRequest", () => late.promise);
  const work = transportNativeGeometry(f.options);
  await vi.advanceTimersByTimeAsync(200);
  expect(await work).toMatchObject({ ok: false });
  late.resolve({ result: { value: { ...f.ticket, scope: { ...scope, graphId: "new" } } } });
  await flush();
  expect(f.calls.some((call) => call.action === "geometryAbort")).toBe(false);
});

it("returns only finite allowlisted diagnostics despite private provider failures", async () => {
  const f = fixture();
  f.handlers.set("DOM.describeNode", () => {
    throw new Error("DO_NOT_EXPORT_DESCRIPTION");
  });
  f.handlers.set("Runtime.releaseObjectGroup", () => {
    throw new Error("CLEANUP_PRIVATE_TEXT");
  });
  const result = await transportNativeGeometry(f.options);
  expect(result).toEqual({
    ok: false,
    reason: "native_protection_geometry_unsupported",
    requests: 1,
    quads: 0,
  });
  expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXPORT|CLEANUP_PRIVATE/);
  expect(f.calls.filter((call) => call.action === "geometryAbort")).toHaveLength(1);
});

it("requires exact graph acceptance rather than a truthy partial response", async () => {
  const f = fixture();
  f.handlers.set("geometryAccept", () => ({ result: { value: { accepted: 0 } } }));
  expect(await transportNativeGeometry(f.options)).toMatchObject({ ok: false });
  expect(f.calls.filter((call) => call.action === "geometryAbort")).toHaveLength(1);
});

it("does not inspect arbitrary provider exception properties", async () => {
  const f = fixture();
  let inspected = false;
  const error = Object.defineProperty({}, "reason", {
    get() {
      inspected = true;
      throw new Error("private provider diagnostic");
    },
  });
  f.handlers.set("DOM.describeNode", () => {
    throw error;
  });
  expect(await transportNativeGeometry(f.options)).toEqual({
    ok: false,
    reason: "native_protection_geometry_unsupported",
    requests: 1,
    quads: 0,
  });
  expect(inspected).toBe(false);
});

const browserTest = process.env.SCRY_BROWSER_E2E === "1" ? it : it.skip;
// The graph is a fixture owner here; all DOM identity and quad measurements are
// actual Chromium protocol calls. No geometry or rendered ink is mocked.
for (const location of ["main", "translated-child", "scaled-child"] as const) {
  browserTest(`real CDP: ${location} pseudo geometry`, async () => {
    vi.useRealTimers();
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SCRY_BROWSER_CHANNEL ? { channel: process.env.SCRY_BROWSER_CHANNEL } : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const html =
        '<style>body{margin:0}#owner{margin:15px 10px;width:180px;height:40px}#owner::after{content:"FICTIONAL_LABEL";display:block;font:20px/30px monospace}</style><div id="owner"></div>';
      if (location === "main") await page.setContent(html);
      else {
        await page.setContent(
          '<iframe style="position:absolute;left:120px;top:140px;border:0;width:400px;height:220px;transform-origin:0 0;' +
            (location === "scaled-child" ? "transform:scale(1.5)" : "") +
            '"></iframe>',
        );
        await page.frames()[1]!.setContent(html);
      }
      const session = await page.context().newCDPSession(page);
      const tree = await session.send("Page.getFrameTree");
      const frameId =
        location === "main" ? tree.frameTree.frame.id : tree.frameTree.childFrames![0]!.frame.id;
      const world = await session.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "geometry-transport-fixture",
      });
      await session.send("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: `(() => {
          const owner=document.getElementById('owner'),r=owner.getBoundingClientRect();
          const scope={instanceId:'browser-instance',graphId:'browser-graph'};
          const ticket={version:1,nonce:'browser-ticket',readId:7,policyGeneration:3,revision:2,scope,
            requests:[{token:'known-owner',pseudo:'after',localBox:{left:r.left,top:r.top,width:r.width,height:r.height}}]};
          globalThis.__scryNativeGraph={
            geometryRequest:()=>ticket,
            geometryOwner:()=>owner,
            geometryAbort:()=>{},
            geometryAccept:(t,f)=>{
              const q=f[0]?.quads?.[0];
              // Coordinate confirmation stays in the isolated fixture; only a
              // finite count reaches the test runner.
              const local=q&&q[0]>=r.left-1&&q[0]<=r.left+1&&q[1]>=r.top-1&&q[1]<=r.top+1;
              return {accepted:local?f.length:0};
            }
          };
        })()`,
      });
      const result = await transportNativeGeometry({
        session,
        contextId: world.executionContextId,
        frameId,
        isMainFrame: location === "main",
        readId: 7,
        policyGeneration: 3,
        expectedScope: { instanceId: "browser-instance", graphId: "browser-graph" },
        deadline: Date.now() + 1000,
        isCurrent: () => true,
      });
      expect(result).toEqual(
        location === "scaled-child"
          ? { ok: false, reason: "native_protection_geometry_unsupported", requests: 1, quads: 0 }
          : { ok: true, requests: 1, quads: 1 },
      );
    } finally {
      await browser.close();
    }
  });
}
