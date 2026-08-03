import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = process.cwd();
const inventory = JSON.parse(
  await readFile(resolve(root, "docs/architecture/praxis-veil-boundary-inventory.json"), "utf8"),
);
const failures = [];
const sourceFiles = await sourceTree(root);

const forbiddenDependencies = new Map([
  [
    "packages/contracts",
    new Set(["@scry/artifact", "@scry/policy", "@scry/praxis", "@scry/veil", "@scry/executor"]),
  ],
  ["packages/artifact", new Set(["@scry/policy", "@scry/praxis", "@scry/veil", "@scry/executor"])],
  ["packages/policy", new Set(["@scry/artifact", "@scry/praxis", "@scry/veil", "@scry/executor"])],
  ["packages/veil", new Set(["@scry/praxis", "@scry/executor"])],
  ["packages/praxis", new Set(["@scry/executor"])],
]);

for (const file of sourceFiles) {
  const path = relative(root, file);
  const source = await readFile(file, "utf8");
  const imports = [...source.matchAll(/(?:from\s*|import\s*)["'](@scry\/[^"']+)["']/g)].map(
    (match) => match[1],
  );
  for (const specifier of imports) {
    if (/^@scry\/(?:praxis|veil)\//.test(specifier))
      failures.push(`deep subsystem import is forbidden: ${path} -> ${specifier}`);
    for (const [owner, forbidden] of forbiddenDependencies) {
      if ((path === owner || path.startsWith(`${owner}/`)) && forbidden.has(specifier))
        failures.push(`forbidden dependency: ${path} -> ${specifier}`);
    }
  }
}

const composition = [...(inventory.applicationComposition ?? [])].sort();
const discovered = sourceFiles
  .map((file) => relative(root, file))
  .filter((path) => !path.startsWith("packages/praxis/") && !path.startsWith("packages/veil/"))
  .filter((path) => /\/(?:praxis|veil)(?:-|\.)/i.test(path))
  .filter((path) => !composition.includes(path))
  .sort();
const classified = [...inventory.transitionalSources].sort();
if (new Set(classified).size !== classified.length)
  failures.push("transitional subsystem inventory contains duplicate sources");
for (const path of discovered)
  if (!classified.includes(path))
    failures.push(`unclassified transitional subsystem source: ${path}`);
for (const path of classified)
  if (!discovered.includes(path)) failures.push(`stale transitional subsystem source: ${path}`);
const sourcePaths = new Set(sourceFiles.map((file) => relative(root, file)));
for (const path of composition) {
  if (!path.startsWith("apps/"))
    failures.push(`subsystem application composition must remain application-owned: ${path}`);
  if (!sourcePaths.has(path))
    failures.push(`subsystem application composition does not exist: ${path}`);
}
const adapters = [...(inventory.applicationAdapters ?? [])].sort();
if (new Set(adapters).size !== adapters.length)
  failures.push("subsystem application-adapter inventory contains duplicate sources");
for (const path of adapters) {
  if (!path.startsWith("apps/"))
    failures.push(`subsystem application adapter must remain application-owned: ${path}`);
  if (!sourcePaths.has(path))
    failures.push(`subsystem application adapter does not exist: ${path}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Subsystem boundaries verified; ${classified.length} transitional sources remain, ${adapters.length} application adapters and ${composition.length} composition roots are classified, and no forbidden dependency was found.\n`,
);

async function sourceTree(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceTree(path)));
    else if (
      [".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name)) &&
      !/(?:^|\/)(?:test|tests|__tests__|scripts)\//.test(relative(root, path)) &&
      !/\.test\.[^.]+$/.test(entry.name)
    )
      output.push(path);
  }
  return output;
}
