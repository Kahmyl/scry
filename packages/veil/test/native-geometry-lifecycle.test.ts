import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// Exercise the actual browser capability's ticket lifecycle. These tests do not
// establish paint geometry: real-CDP and pixel suites own that separate proof.
function fixture(styleBytes = 0) {
  let graph = {
    id: 7,
    revision: 2,
    policyGeneration: 3,
    owners: [] as object[],
    elements: [] as object[],
  };
  const document = { fonts: { status: "loaded" } };
  const create = runInNewContext(
    readFileSync(new URL("../src/native-geometry.browser.js", import.meta.url), "utf8") +
      "\nnativeCreateGeometryCapability",
    {
      crypto: webcrypto,
      performance: { now: () => 0 },
      document,
      getComputedStyle: () => ({
        [Symbol.iterator]: function* () {
          yield "font";
        },
        getPropertyValue: () => "x".repeat(styleBytes),
        font: "20px monospace",
        letterSpacing: "normal",
        wordSpacing: "normal",
        direction: "ltr",
      }),
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
    },
  );
  const capability = create({
    graph: () => graph,
    revision: () => graph.revision,
    policy: () => graph.policyGeneration,
    readId: () => graph.id,
    disposed: () => false,
    visible: () => true,
    pseudoValue: () => ({ supported: true, value: "FICTIONAL" }),
    unsupportedStyle: () => false,
    unsupportedTextInk: () => false,
    paintChainSupported: () => true,
    ancestor: () => true,
    nativeEnvelope: () => null,
  });
  const next = () => {
    graph = { id: graph.id + 1, revision: 2, policyGeneration: 3, owners: [], elements: [] };
    capability.newRead(graph.id);
  };
  const owner = () => {
    const element = {
      isConnected: true,
      childNodes: [],
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 180,
        height: 40,
        right: 180,
        bottom: 40,
      }),
    };
    graph.owners = [
      { element, kind: "pseudo", pseudo: "::after", value: "FICTIONAL", whole: true },
    ];
    graph.elements = [element];
  };
  const request = () => capability.request(graph.id, 200, capability.scope(graph));
  return { capability, document, next, owner, request, graph: () => graph };
}

it.each(["scope", "nonce"])("foreign %s accept cannot poison the active ticket", (field) => {
  const f = fixture(),
    ticket = f.request();
  const foreign =
    field === "scope"
      ? { ...ticket, scope: { ...ticket.scope, instanceId: "retired-instance" } }
      : { ...ticket, nonce: "retired-nonce" };
  expect(f.capability.accept(foreign, [])).toEqual({ reason: "native_protection_geometry_stale" });
  expect(f.capability.reason(f.graph())).toBeUndefined();
  expect(f.request()).toEqual(ticket);
  expect(f.capability.accept(ticket, [])).toEqual({ accepted: 0 });
});

it("a late prior-read accept cannot poison a replacement graph with reused context identity", () => {
  const f = fixture(),
    old = f.request();
  f.next();
  const fresh = f.request();
  expect(f.capability.accept(old, [])).toEqual({ reason: "native_protection_geometry_stale" });
  expect(f.capability.reason(f.graph())).toBeUndefined();
  expect(f.request()).toEqual(fresh);
  expect(f.capability.accept(fresh, [])).toEqual({ accepted: 0 });
});

it.each(["layout-capacity", "font-loading"])(
  "a %s stamp refusal does not strand the next read",
  (failure) => {
    const f = fixture();
    f.owner();
    if (failure === "layout-capacity") {
      const element = f.graph().elements[0]!;
      f.graph().elements = Array.from({ length: 129 }, () => element);
    } else f.document.fonts.status = "loading";
    expect(f.request()).toEqual({ reason: "native_protection_graph_capacity" });
    f.document.fonts.status = "loaded";
    expect(() => f.next()).not.toThrow();
    expect(f.request()).toMatchObject({ version: 1, readId: 8 });
    expect(f.capability.reason(f.graph())).toBeUndefined();
  },
);

it("a foreign abort does not revoke the current graph ticket", () => {
  const f = fixture(),
    old = f.request();
  f.next();
  const fresh = f.request();
  expect(f.capability.abort(old)).toEqual({ reason: "native_protection_geometry_stale" });
  expect(f.capability.reason(f.graph())).toBeUndefined();
  expect(f.capability.accept(fresh, [])).toEqual({ accepted: 0 });
});

it("a matching abort remains a failed-read fence and cannot be reopened by retry", () => {
  const f = fixture(),
    ticket = f.request();
  expect(f.capability.abort(ticket)).toEqual({ reason: "native_protection_geometry_stale" });
  expect(f.request()).toEqual({ reason: "native_protection_geometry_stale" });
});

it("retains only enumerated refusal reasons on an owned abort", () => {
  const f = fixture(),
    ticket = f.request();
  expect(f.capability.abort(ticket, "native_protection_geometry_unsupported")).toEqual({
    reason: "native_protection_geometry_unsupported",
  });
  expect(f.request()).toEqual({ reason: "native_protection_geometry_unsupported" });
  f.next();
  expect(f.capability.abort(f.request(), "PRIVATE_PROVIDER_ERROR")).toEqual({
    reason: "native_protection_geometry_stale",
  });
});

it("bounds the private layout witness before retaining oversized computed styles", () => {
  const f = fixture(131073);
  f.owner();
  expect(f.request()).toEqual({ reason: "native_protection_graph_capacity" });
  f.next();
  expect(f.request()).toMatchObject({ version: 1, readId: 8 });
});
