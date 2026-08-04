import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = path.join(root, "apps/api/src");
const mcpSource = path.join(root, "apps/mcp/src");
const webSource = path.join(root, "apps/web/src");

const allowedApiRootFiles = new Set(["app.module.ts", "main.ts", "worker.ts"]);

const entries = await readdir(apiSource, { withFileTypes: true });
const violations = entries
  .filter((entry) => entry.isFile() && !allowedApiRootFiles.has(entry.name))
  .map((entry) => `API source root accepts composition only: apps/api/src/${entry.name}`);

const appModule = await readFile(path.join(apiSource, "app.module.ts"), "utf8");
for (const requiredModule of [
  "AccessModule",
  "ArtifactsModule",
  "AuthModule",
  "AuthoringModule",
  "CalibrationModule",
  "FlowsModule",
  "InfrastructureModule",
  "MissionsModule",
  "OrchestrationModule",
  "RuntimeModule",
  "RunsModule",
  "SystemModule",
  "VeilModule",
]) {
  if (!appModule.includes(requiredModule))
    violations.push(`AppModule does not compose ${requiredModule}`);
}

const categoryConventions = [
  { suffix: ".controller.ts", folder: "controllers" },
  { suffix: ".service.ts", folder: "services" },
  { suffix: ".repository.ts", folder: "repositories" },
  { suffix: ".processor.ts", folder: "processors" },
];
for (const domain of entries.filter((entry) => entry.isDirectory())) {
  const domainPath = path.join(apiSource, domain.name);
  const domainEntries = await readdir(domainPath, { withFileTypes: true });
  for (const convention of categoryConventions) {
    const rootPeers = domainEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(convention.suffix),
    );
    const categoryEntry = domainEntries.find(
      (entry) => entry.isDirectory() && entry.name === convention.folder,
    );
    const categoryPeers = categoryEntry
      ? (await readdir(path.join(domainPath, convention.folder), { withFileTypes: true })).filter(
          (entry) => entry.isFile() && entry.name.endsWith(convention.suffix),
        )
      : [];
    const peerCount = rootPeers.length + categoryPeers.length;
    if (peerCount > 1 && (rootPeers.length > 0 || !categoryEntry)) {
      violations.push(
        `${domain.name} has ${peerCount} ${convention.suffix} peers; all must live in ${convention.folder}/`,
      );
    }
    if (peerCount <= 1 && categoryPeers.length > 0) {
      violations.push(
        `${domain.name}/${convention.folder} is unnecessary for ${peerCount} ${convention.suffix} peer`,
      );
    }
  }
}

const allowedMcpRootFiles = new Set([
  "api-client.ts",
  "http.ts",
  "main.ts",
  "server-composition.ts",
  "server.ts",
  "tool-registry.ts",
]);
const mcpEntries = await readdir(mcpSource, { withFileTypes: true });
for (const entry of mcpEntries) {
  if (entry.isFile() && !allowedMcpRootFiles.has(entry.name))
    violations.push(
      `MCP source root accepts composition and transport only: apps/mcp/src/${entry.name}`,
    );
}

const mcpToolsRoot = path.join(mcpSource, "tools");
const toolDomains = await readdir(mcpToolsRoot, { withFileTypes: true });
for (const entry of toolDomains) {
  if (!entry.isDirectory()) {
    violations.push(`MCP tools root accepts domain folders only: apps/mcp/src/tools/${entry.name}`);
    continue;
  }
  const domainPath = path.join(mcpToolsRoot, entry.name);
  const domainEntries = await readdir(domainPath, { withFileTypes: true });
  const index = domainEntries.find(
    (candidate) => candidate.isFile() && candidate.name === "index.ts",
  );
  if (!index) {
    violations.push(`MCP tool domain has no registrar: apps/mcp/src/tools/${entry.name}/index.ts`);
    continue;
  }
  const registrar = await readFile(path.join(domainPath, "index.ts"), "utf8");
  const toolFiles = domainEntries.filter(
    (candidate) => candidate.isFile() && candidate.name.endsWith(".tool.ts"),
  );
  if (toolFiles.length === 0)
    violations.push(`MCP tool domain is empty: apps/mcp/src/tools/${entry.name}`);
  for (const toolFile of toolFiles) {
    const source = await readFile(path.join(domainPath, toolFile.name), "utf8");
    const registrations = source.match(/server\.registerTool\(/g)?.length ?? 0;
    if (registrations !== 1)
      violations.push(
        `MCP tool file must register exactly one tool: apps/mcp/src/tools/${entry.name}/${toolFile.name}`,
      );
    const importPath = `./${toolFile.name.replace(/\.ts$/, ".js")}`;
    if (!registrar.includes(importPath))
      violations.push(
        `MCP domain registrar omits tool file: apps/mcp/src/tools/${entry.name}/${toolFile.name}`,
      );
  }
}

const mcpServer = await readFile(path.join(mcpSource, "server.ts"), "utf8");
for (const domain of toolDomains.filter((entry) => entry.isDirectory())) {
  if (!mcpServer.includes(`./tools/${domain.name}/index.js`))
    violations.push(`MCP server does not compose the ${domain.name} tool domain`);
}

const allowedWebRootFiles = new Set(["main.tsx"]);
const requiredWebLayers = new Set(["app", "features", "infrastructure", "shared", "styles"]);
const webEntries = await readdir(webSource, { withFileTypes: true });
for (const entry of webEntries) {
  if (entry.isFile() && !allowedWebRootFiles.has(entry.name))
    violations.push(`Web source root accepts bootstrap only: apps/web/src/${entry.name}`);
}
for (const layer of requiredWebLayers) {
  if (!webEntries.some((entry) => entry.isDirectory() && entry.name === layer))
    violations.push(`Web source is missing required layer: apps/web/src/${layer}`);
}

for (const layer of ["app", "features", "infrastructure", "shared"]) {
  const layerPath = path.join(webSource, layer);
  const layerEntries = await readdir(layerPath, { withFileTypes: true });
  const domains =
    layer === "app"
      ? [{ name: ".", path: layerPath }]
      : layerEntries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, path: path.join(layerPath, entry.name) }));
  for (const domain of domains) {
    const domainEntries = await readdir(domain.path, { withFileTypes: true });
    if (!domainEntries.some((entry) => entry.isFile() && entry.name === "index.ts"))
      violations.push(
        `Web boundary has no public entry point: apps/web/src/${layer}/${domain.name}/index.ts`,
      );
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Repository topology verified: API, MCP, and web roots contain composition only and every capability is domain-owned.\n",
  );
}
