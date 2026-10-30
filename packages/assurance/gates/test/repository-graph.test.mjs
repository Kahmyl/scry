import assert from "node:assert/strict";
import test from "node:test";
import { moduleReferences, traceSourceGraph } from "../repository-graph.mjs";

function graph(sources, roots = ["apps/example/src/main.ts"]) {
  return traceSourceGraph({
    roots,
    files: new Set(Object.keys(sources)),
    entries: new Map([["@scry/contracts", "packages/contracts/src/index.ts"]]),
    read: (filename) => sources[filename],
  });
}

test("follows cycles, re-exports and TypeScript extension substitution without inventing roots", () => {
  const result = graph({
    "apps/example/src/main.ts": 'export * from "./service.js";',
    "apps/example/src/service.ts": 'import "./main.js";',
    "apps/example/src/displaced.ts": "export const unused = true;",
  });
  assert.deepEqual([...result.reachable].sort(), [
    "apps/example/src/main.ts",
    "apps/example/src/service.ts",
  ]);
  assert.deepEqual(result.missing, []);
});

test("follows public workspace contracts, type imports and literal lazy imports", () => {
  const result = graph({
    "apps/example/src/main.ts":
      'type Contract = import("@scry/contracts").Contract; await import("./lazy.js");',
    "apps/example/src/lazy.ts": "",
    "packages/contracts/src/index.ts": "export type Contract = { id: string };",
  });
  assert.equal(result.reachable.size, 3);
  assert.deepEqual(result.missing, []);
});

test("reports missing relative files and retired workspace packages instead of ignoring them", () => {
  const result = graph({
    "apps/example/src/main.ts": 'import "./removed.js"; import "@scry/executor";',
  });
  assert.deepEqual(
    result.missing.map((item) => item.specifier),
    ["./removed.js", "@scry/executor"],
  );
});

test("computed module loads remain unresolved evidence, never a clean closure", () => {
  for (const source of [
    "await import(target);",
    "require(target);",
    "await import(`./${target}.js`);",
  ]) {
    assert.deepEqual(graph({ "apps/example/src/main.ts": source }).computed, [
      "apps/example/src/main.ts",
    ]);
  }
});

test("keeps child-process fixtures referenced through literal import-relative URLs", () => {
  const result = graph({
    "apps/example/src/main.ts":
      'new URL("../test/crash.ts", import.meta.url); require("./service.js");',
    "apps/example/test/crash.ts": "",
    "apps/example/src/service.ts": "",
  });
  assert.equal(result.reachable.size, 3);
  assert.deepEqual(result.missing, []);
});

test("module-like text in comments and strings does not revive a displaced implementation", () => {
  const parsed = moduleReferences(
    "example.ts",
    '// import "@scry/executor";\nconst example = \'import "@scry/policy"\'; import "node:fs";',
  );
  assert.deepEqual(parsed.references, ["node:fs"]);
  assert.equal(parsed.computed, false);
});
