import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleReferences, traceSourceGraph } from "./repository-graph.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
process.chdir(root);
const read = (filename) => readFileSync(path.join(root, filename), "utf8");
const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((filename) => filename && existsSync(path.join(root, filename))),
);
const workspaces = [
  "apps/api",
  "apps/mcp",
  "apps/web",
  "packages/contracts",
  "packages/praxis",
  "packages/veil",
  "packages/chronicle",
  "packages/assurance",
];
const productionRoots = [
  "apps/api/src/main.ts",
  "apps/api/src/worker.ts",
  "apps/api/scripts/migrate.ts",
  "apps/api/scripts/activate-schema.ts",
  "apps/mcp/src/main.ts",
  "apps/mcp/src/http.ts",
  "apps/web/src/main.tsx",
];
const manifests = new Map(
  workspaces.map((directory) => [directory, JSON.parse(read(`${directory}/package.json`))]),
);
const entries = new Map(
  [...manifests]
    .filter(([, manifest]) => manifest.exports?.["."])
    .map(([directory, manifest]) => [
      manifest.name,
      path.posix.join(directory, manifest.exports["."]),
    ]),
);
const fail = (message) => {
  throw new Error(`SCRY_REPOSITORY_CLOSURE_FAILED: ${message}`);
};

const workspaceConfiguration = [
  ...read("pnpm-workspace.yaml").matchAll(/^\s*-\s*["']([^"']+)["']\s*$/gmu),
].map((match) => match[1]);
if ([...workspaceConfiguration].sort().join("\n") !== [...workspaces].sort().join("\n"))
  fail("workspace discovery does not select exactly the baseline owners");
for (const filename of files) {
  if (
    /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(filename) &&
    !manifests.has(path.posix.dirname(filename))
  )
    fail(`non-baseline workspace remains: ${filename}`);
  if (
    /^(?:apps\/agent-lab\/|apps\/api\/migrations\/|apps\/mcp\/scripts\/|experiments\/(?!browser-foundation\/)|packages\/(?:executor|policy|observability)\/|scripts\/fixtures\/)/u.test(
      filename,
    )
  )
    fail(`displaced implementation remains: ${filename}`);
}

const production = traceSourceGraph({ roots: productionRoots, files, entries, read });
for (const filename of production.reachable)
  if (filename.startsWith("experiments/"))
    fail(`production imports isolated experiment: ${filename}`);
const supportRoots = [...files].filter(
  (filename) =>
    !filename.startsWith("experiments/") &&
    /(?:\.test\.[cm]?[jt]sx?$|^packages\/assurance\/gates\/verify-[^/]+\.mjs$|^scripts\/[^/]+\.mjs$)/u.test(
      filename,
    ),
);
const supported = traceSourceGraph({
  roots: [
    ...productionRoots,
    ...entries.values(),
    ...supportRoots,
    "packages/assurance/scripts/qualify.ts",
    "apps/web/vite.config.ts",
    "apps/web/scripts/serve-dist.mjs",
  ],
  files,
  entries,
  read,
});
for (const [name, graph] of [
  ["production", production],
  ["supported", supported],
]) {
  if (graph.missing.length)
    fail(`${name} has unresolved local imports: ${JSON.stringify(graph.missing)}`);
  if (graph.computed.length)
    fail(`${name} has unaccounted computed module loads: ${graph.computed.join(", ")}`);
}
for (const filename of files) {
  const implementation = /^(?:apps\/[^/]+\/src\/|packages\/(?!assurance\/)[^/]+\/src\/)/u.test(
    filename,
  );
  const supportedSource =
    /^(?:apps|packages)\/[^/]+\/(?:src|test|scripts)\/.*\.[cm]?[jt]sx?$/u.test(filename);
  if (
    implementation &&
    !/\.(?:test|spec)\./u.test(filename) &&
    /\.[cm]?[jt]sx?$/u.test(filename) &&
    !production.reachable.has(filename)
  )
    fail(`source outside the production closure: ${filename}`);
  if (supportedSource && !supported.reachable.has(filename))
    fail(`source outside the supported verification/operational closure: ${filename}`);
}

for (const filename of supported.reachable) {
  if (!/\.[cm]?[jt]sx?$/u.test(filename)) continue;
  const owner = workspaces.find((directory) => filename.startsWith(`${directory}/`));
  if (!owner) continue;
  const manifest = manifests.get(owner);
  const dependencies = production.reachable.has(filename)
    ? manifest.dependencies
    : { ...manifest.dependencies, ...manifest.devDependencies };
  for (const specifier of moduleReferences(filename, read(filename)).references) {
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("node:") ||
      builtinModules.includes(specifier)
    )
      continue;
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (!dependencies?.[name])
      fail(
        `${filename} uses an undeclared ${production.reachable.has(filename) ? "runtime" : "verification"} dependency: ${name}`,
      );
  }
}
process.stdout.write(
  `${JSON.stringify({ verdict: "pass", workspaces: workspaces.length, productionFiles: production.reachable.size, supportedFiles: supported.reachable.size, unresolvedImports: 0, displacedSources: 0 })}\n`,
);
