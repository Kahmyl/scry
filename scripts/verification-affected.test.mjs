import assert from "node:assert/strict";
import test from "node:test";

import {
  STATIC_GATES,
  buildAffectedPlan,
  classifyChangedFiles,
} from "./verification-affected-lib.mjs";

const workspaces = [
  {
    name: "@scry/contracts",
    path: "packages/contracts",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
  {
    name: "@scry/veil",
    path: "packages/veil",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
  {
    name: "@scry/praxis",
    path: "packages/praxis",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
  {
    name: "@scry/executor",
    path: "packages/executor",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
  {
    name: "@scry/api",
    path: "apps/api",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
  {
    name: "@scry/web",
    path: "apps/web",
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
    },
  },
];

test("package changes map to their owning workspace", () => {
  const classification = classifyChangedFiles(["packages/veil/src/index.ts"], workspaces);

  assert.deepEqual([...classification.direct.keys()], ["@scry/veil"]);

  assert.deepEqual(classification.fullFallbackReasons, []);
});

test("documentation changes do not force package verification", () => {
  const classification = classifyChangedFiles(
    ["docs/rearchitecture/R0-ARCHITECTURE.md"],
    workspaces,
  );

  assert.equal(classification.direct.size, 0);

  assert.deepEqual(classification.fullFallbackReasons, []);
});

test("root package and verification infrastructure force full fallback", () => {
  const classification = classifyChangedFiles(["package.json", "scripts/example.mjs"], workspaces);

  assert.equal(classification.fullFallbackReasons.length, 2);
});

test("unknown paths fail broad instead of narrowing unsafely", () => {
  const classification = classifyChangedFiles(["mystery/runtime-file.xyz"], workspaces);

  assert.deepEqual(classification.fullFallbackReasons, ["unknown:mystery/runtime-file.xyz"]);
});

test("changed package plus downstream dependents are selected", () => {
  const plan = buildAffectedPlan({
    files: ["packages/veil/src/index.ts"],
    workspaces,
    resolveDependents(name) {
      assert.equal(name, "@scry/veil");

      return ["@scry/veil", "@scry/praxis", "@scry/executor", "@scry/api"];
    },
  });

  assert.equal(plan.fullFallback, false);

  assert.deepEqual(
    plan.selected.map((workspace) => workspace.name),
    ["@scry/api", "@scry/executor", "@scry/praxis", "@scry/veil"],
  );
});

test("dependency graph uncertainty expands to all runnable workspaces", () => {
  const plan = buildAffectedPlan({
    files: ["packages/veil/src/index.ts"],
    workspaces,
    resolveDependents() {
      throw new Error("graph unavailable");
    },
  });

  assert.equal(plan.fullFallback, true);

  assert.equal(plan.selected.length, workspaces.length);
});

test("explicit full selects every runnable workspace", () => {
  const plan = buildAffectedPlan({
    files: [],
    workspaces,
    full: true,
    resolveDependents() {
      throw new Error("should not be called");
    },
  });

  assert.equal(plan.fullFallback, true);

  assert.equal(plan.selected.length, workspaces.length);
});

test("static gates stay deliberately small and fixed", () => {
  assert.equal(STATIC_GATES.length, 8);
});
