import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = process.cwd();

const legacyInventory = JSON.parse(
  await readFile(resolve(root, "docs/architecture/praxis-veil-boundary-inventory.json"), "utf8"),
);

const governance = JSON.parse(
  await readFile(
    resolve(root, "docs/rearchitecture/RESPONSIBILITY-DISPOSITION-INVENTORY.json"),
    "utf8",
  ),
);

const phase1 = governance.phase1StaticExceptions;
if (!phase1) throw new Error("Phase 1 static exception ledger is missing");

const failures = [];
const sourceFiles = await sourceTree(root);

const allowedDependencies = new Map([
  ["packages/contracts", new Set()],
  ["packages/veil", new Set(["@scry/contracts"])],
  ["packages/chronicle", new Set(["@scry/contracts"])],
  ["packages/praxis", new Set(["@scry/contracts", "@scry/veil"])],
  [
    "packages/assurance",
    new Set(["@scry/contracts", "@scry/chronicle", "@scry/praxis", "@scry/veil"]),
  ],
]);

const dependencyExceptions = new Map(
  phase1.targetDependencyExceptions.map((entry) => [`${entry.path}|${entry.specifier}`, entry]),
);

const manifestDependencyExceptions = new Map(
  phase1.targetManifestDependencyExceptions.map((entry) => [
    `${entry.path}|${entry.section}|${entry.specifier}`,
    entry,
  ]),
);

if (dependencyExceptions.size !== phase1.targetDependencyExceptions.length) {
  failures.push("Phase 1 target dependency exceptions contain duplicates");
}

if (manifestDependencyExceptions.size !== phase1.targetManifestDependencyExceptions.length) {
  failures.push("Phase 1 target manifest dependency exceptions contain duplicates");
}

for (const exception of [
  ...phase1.targetDependencyExceptions,
  ...phase1.targetManifestDependencyExceptions,
]) {
  const disposition = governance.dispositions.find(
    ({ id }) => id === `package:${exception.specifier}`,
  );

  if (!disposition) {
    failures.push(`dependency exception references unclassified package: ${exception.specifier}`);
  } else if (disposition.disposition !== "DELETE_AFTER_CUTOVER") {
    failures.push(
      `dependency exception target is not DELETE_AFTER_CUTOVER: ${exception.specifier}`,
    );
  }
}

const seenDependencyExceptions = new Set();

for (const file of sourceFiles) {
  const filePath = relative(root, file);
  const source = await readFile(file, "utf8");
  const imports = importSpecifiers(source);

  for (const specifier of imports) {
    const packageSpecifier = scryPackageRoot(specifier);

    if (/^@scry\/(?:praxis|veil)\//.test(specifier)) {
      failures.push(`deep subsystem import is forbidden: ${filePath} -> ${specifier}`);
    }

    if (packageSpecifier === "@scry/assurance" && !filePath.startsWith("packages/assurance/")) {
      failures.push(`production source must not import Assurance: ${filePath}`);
    }

    if (!packageSpecifier?.startsWith("@scry/")) continue;

    for (const [owner, allowed] of allowedDependencies) {
      if (!(filePath === owner || filePath.startsWith(`${owner}/`))) continue;

      if (allowed.has(packageSpecifier)) continue;

      const key = `${filePath}|${packageSpecifier}`;

      if (dependencyExceptions.has(key)) {
        seenDependencyExceptions.add(key);
      } else {
        failures.push(`target dependency violation: ${filePath} -> ${packageSpecifier}`);
      }
    }
  }

  if (filePath.startsWith("packages/veil/src/")) {
    if (imports.includes("playwright")) {
      failures.push(`Veil must not depend on Playwright: ${filePath}`);
    }

    if (
      /\b(?:Page|Browser|BrowserContext|ElementHandle)\b|\bdocument\.|\bquerySelector(?:All)?\s*\(|\bgetBoundingClientRect\s*\(|\.screenshot\s*\(|\.screencast\b/.test(
        source,
      )
    ) {
      failures.push(`Veil contains browser, DOM, geometry, or capture mechanics: ${filePath}`);
    }
  }
}

for (const key of dependencyExceptions.keys()) {
  if (!seenDependencyExceptions.has(key)) {
    failures.push(`stale target dependency exception: ${key}`);
  }
}

const runtimeDependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];

const seenManifestDependencyExceptions = new Set();

for (const [owner, allowed] of allowedDependencies) {
  const manifestPath = `${owner}/package.json`;
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"));

  for (const section of runtimeDependencySections) {
    for (const specifier of Object.keys(manifest[section] ?? {})) {
      if (!specifier.startsWith("@scry/")) continue;
      if (allowed.has(specifier)) continue;

      const key = `${manifestPath}|${section}|${specifier}`;

      if (manifestDependencyExceptions.has(key)) {
        seenManifestDependencyExceptions.add(key);
      } else {
        failures.push(
          `target manifest dependency violation: ${manifestPath} ${section} -> ${specifier}`,
        );
      }
    }
  }
}

for (const key of manifestDependencyExceptions.keys()) {
  if (!seenManifestDependencyExceptions.has(key)) {
    failures.push(`stale target manifest dependency exception: ${key}`);
  }
}

for (const workspaceRoot of ["apps", "packages"]) {
  const workspaceEntries = await readdir(resolve(root, workspaceRoot), {
    withFileTypes: true,
  });

  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = resolve(root, workspaceRoot, entry.name, "package.json");

    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }

    if (manifest.name === "@scry/assurance") continue;

    for (const section of runtimeDependencySections) {
      if (manifest[section]?.["@scry/assurance"]) {
        failures.push(
          `production package must not depend on Assurance: ${workspaceRoot}/${entry.name}/package.json ${section}`,
        );
      }
    }
  }
}

const composition = [...(legacyInventory.applicationComposition ?? [])].sort();

const discovered = sourceFiles
  .map((file) => relative(root, file))
  .filter((filePath) => !filePath.startsWith("packages/praxis/"))
  .filter((filePath) => !filePath.startsWith("packages/veil/"))
  .filter((filePath) => /\/(?:praxis|veil)(?:-|\.)/i.test(filePath))
  .filter((filePath) => !composition.includes(filePath))
  .sort();

const classified = [...legacyInventory.transitionalSources].sort();

if (new Set(classified).size !== classified.length) {
  failures.push("transitional subsystem inventory contains duplicate sources");
}

for (const filePath of discovered) {
  if (!classified.includes(filePath)) {
    failures.push(`unclassified transitional subsystem source: ${filePath}`);
  }
}

for (const filePath of classified) {
  if (!discovered.includes(filePath)) {
    failures.push(`stale transitional subsystem source: ${filePath}`);
  }
}

const sourcePaths = new Set(sourceFiles.map((file) => relative(root, file)));

for (const filePath of composition) {
  if (!filePath.startsWith("apps/")) {
    failures.push(`subsystem application composition must remain application-owned: ${filePath}`);
  }

  if (!sourcePaths.has(filePath)) {
    failures.push(`subsystem application composition does not exist: ${filePath}`);
  }
}

const adapters = [...(legacyInventory.applicationAdapters ?? [])].sort();

if (new Set(adapters).size !== adapters.length) {
  failures.push("subsystem application-adapter inventory contains duplicate sources");
}

for (const filePath of adapters) {
  if (!filePath.startsWith("apps/")) {
    failures.push(`subsystem application adapter must remain application-owned: ${filePath}`);
  }

  if (!sourcePaths.has(filePath)) {
    failures.push(`subsystem application adapter does not exist: ${filePath}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Subsystem boundaries verified; ${dependencyExceptions.size} frozen source dependency exceptions, ${manifestDependencyExceptions.size} frozen manifest dependency exceptions, zero production Assurance imports, ${classified.length} legacy transitional sources, ${adapters.length} application adapters, and ${composition.length} composition roots remain classified.\n`,
);

function importSpecifiers(source) {
  const found = [];

  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }

  return [...new Set(found)];
}

function scryPackageRoot(specifier) {
  if (!specifier.startsWith("@scry/")) return null;

  const parts = specifier.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
}

async function sourceTree(directory) {
  const output = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage", "artifacts"].includes(entry.name)) continue;

    const filePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      output.push(...(await sourceTree(filePath)));
    } else if (
      [".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name)) &&
      !/(?:^|\/)(?:test|tests|__tests__|scripts)\//.test(relative(root, filePath)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
    ) {
      output.push(filePath);
    }
  }

  return output;
}
