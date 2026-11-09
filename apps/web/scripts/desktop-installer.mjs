// Standalone installer: Node built-ins only. No package scripts, shell or OAuth credentials.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = "https://scry.giize.com/mcp";
const paths = [
  "plugin.json",
  "mcp.json",
  "README.md",
  "assets/scry.png",
  "skills/scry-setup/SKILL.md",
  "skills/scry-test-web-app/SKILL.md",
  "skills/scry-review-results/SKILL.md",
];
const fail = (code) => {
  throw new Error(code);
};
const digest = (data) => createHash("sha256").update(data).digest("hex");

export function validatePackage(data) {
  if (
    !data ||
    !/^\d+\.\d+\.\d+$/.test(data.version) ||
    !Array.isArray(data.files) ||
    data.files.length !== paths.length
  )
    fail("INVALID_PACKAGE");
  const files = new Map();
  for (const entry of data.files) {
    if (
      !paths.includes(entry.path) ||
      files.has(entry.path) ||
      typeof entry.base64 !== "string" ||
      entry.base64.length > 1400000
    )
      fail("INVALID_PACKAGE_PATH");
    const contents = Buffer.from(entry.base64, "base64");
    if (
      !contents.length ||
      contents.toString("base64") !== entry.base64 ||
      digest(contents) !== entry.sha256
    )
      fail("PACKAGE_CHECKSUM_MISMATCH");
    files.set(entry.path, contents);
  }
  const manifest = JSON.parse(files.get("plugin.json").toString());
  const settings = manifest.extensions?.["com.openai"];
  if (
    manifest.name !== "scry" ||
    manifest.version !== data.version ||
    manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
    settings?.apps ||
    settings?.hooks
  )
    fail("INVALID_PLUGIN_MANIFEST");
  const mcp = JSON.parse(files.get("mcp.json").toString());
  const servers = mcp.mcpServers;
  if (
    mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" ||
    Object.keys(servers ?? {}).length !== 1 ||
    servers.scry?.url !== endpoint ||
    servers.scry?.type !== "streamable-http"
  )
    fail("INVALID_MCP_ENDPOINT");
  const auth = servers.scry.extensions?.["com.openai"]?.auth;
  if (
    auth?.type !== "oauth" ||
    auth.client?.mode !== "dcr" ||
    JSON.stringify(auth.baseScopes) !== '["scry:testing"]' ||
    JSON.stringify(auth.defaultScopes) !== '["scry:testing"]' ||
    servers.scry.headers
  )
    fail("INVALID_MCP_AUTH");
  for (const [name, contents] of files) {
    if (
      name.endsWith("SKILL.md") &&
      !/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\r?\n---/.test(
        contents.toString(),
      )
    )
      fail("INVALID_SKILL");
    if (
      name !== "assets/scry.png" &&
      /"clientSecret"\s*:|-----BEGIN (?:RSA )?PRIVATE KEY|scry_mcp_[A-Za-z0-9_-]{15,}/.test(
        contents.toString(),
      )
    )
      fail("PACKAGE_CONTAINS_CREDENTIALS");
  }
  return files;
}

async function stat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function directory(path) {
  const existing = await stat(path);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    fail("UNSAFE_INSTALL_DIRECTORY");
  if (!existing) await mkdir(path, { mode: 0o700 });
}
async function unchangedOrMissing(path, expected) {
  const existing = await stat(path);
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink() || !(await readFile(path)).equals(expected))
    fail("EXISTING_SCRY_FILES_DIFFER");
}

export function codex(args) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) fail("CODEX_COMMAND_FAILED");
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("INVALID_CODEX_RESPONSE");
  }
}

export async function install(data, { userDirectory = homedir(), run = codex } = {}) {
  const started = performance.now();
  const files = validatePackage(data);
  const root = join(userDirectory, ".scry", "marketplace");
  const catalog = {
    name: "scry-beta",
    interface: { displayName: "Scry beta" },
    plugins: [
      {
        name: "scry",
        source: { source: "local", path: "./plugins/scry" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  };
  const marketplaces = run(["plugin", "marketplace", "list", "--json"]);
  if (!Array.isArray(marketplaces.marketplaces)) fail("INVALID_MARKETPLACE_RESPONSE");
  const existing = marketplaces.marketplaces.find((entry) => entry.name === "scry-beta");
  if (existing && resolve(existing.root) !== resolve(root)) fail("SCRY_MARKETPLACE_CONFLICT");
  // Check every parent and existing file before writing. Never follow a symlink.
  const directories = [
    ".scry",
    ".scry/marketplace",
    ".scry/marketplace/plugins",
    ".scry/marketplace/plugins/scry",
    ".scry/marketplace/.agents",
    ".scry/marketplace/.agents/plugins",
    ".scry/marketplace/plugins/scry/assets",
    ".scry/marketplace/plugins/scry/skills",
    ...["scry-setup", "scry-test-web-app", "scry-review-results"].map(
      (name) => `.scry/marketplace/plugins/scry/skills/${name}`,
    ),
  ];
  for (const name of directories) {
    const item = await stat(join(userDirectory, name));
    if (item && (!item.isDirectory() || item.isSymbolicLink())) fail("UNSAFE_INSTALL_DIRECTORY");
  }
  const plugin = join(root, "plugins", "scry");
  async function checkTree(folder, prefix = "") {
    if (!(await stat(folder))) return;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (
        entry.isSymbolicLink() ||
        (!files.has(name) && !paths.some((path) => path.startsWith(name + "/")))
      )
        fail("UNEXPECTED_EXISTING_FILE");
      if (entry.isDirectory()) await checkTree(join(folder, entry.name), name + "/");
    }
  }
  await checkTree(plugin);
  for (const [name, contents] of files) await unchangedOrMissing(join(plugin, name), contents);
  const catalogPath = join(root, ".agents", "plugins", "marketplace.json");
  if (await stat(catalogPath)) {
    const item = await lstat(catalogPath);
    if (
      !item.isFile() ||
      item.isSymbolicLink() ||
      JSON.stringify(JSON.parse(await readFile(catalogPath, "utf8"))) !== JSON.stringify(catalog)
    )
      fail("SCRY_CATALOG_CONFLICT");
  }
  for (const name of directories) await directory(join(userDirectory, name));
  for (const [name, contents] of files) {
    if (!(await stat(join(plugin, name))))
      await writeFile(join(plugin, name), contents, { flag: "wx", mode: 0o644 });
  }
  if (!(await stat(catalogPath)))
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", {
      flag: "wx",
      mode: 0o644,
    });
  if (!existing) run(["plugin", "marketplace", "add", root, "--json"]);
  const result = run(["plugin", "add", "scry@scry-beta", "--json"]);
  if (result.pluginId !== "scry@scry-beta" || result.version !== data.version)
    fail("INSTALL_NOT_CONFIRMED");
  return {
    status: "installed",
    pluginId: result.pluginId,
    version: data.version,
    elapsedMs: Math.round(performance.now() - started),
    authorization:
      "Complete the plugin's Connect action in the host; installation is not verified account access.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const response = await fetch("https://scry.giize.com/plugins/scry-desktop-package.json", {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 2000000)
      fail("PACKAGE_DOWNLOAD_FAILED");
    const data = await response.json();
    if (process.argv.includes("--check")) {
      validatePackage(data);
      console.log(JSON.stringify({ status: "validated", version: data.version, writes: false }));
    } else console.log(JSON.stringify(await install(data)));
  } catch (error) {
    const known =
      /^(?:INVALID_|PACKAGE_|CODEX_|SCRY_|UNSAFE_|EXISTING_|UNEXPECTED_|INSTALL_)[A-Z_]+$/;
    console.error(
      JSON.stringify({
        status: "failed",
        code: known.test(error.message) ? error.message : "INSTALLER_FAILED",
        message:
          "Scry setup stopped. Existing connections were not authenticated or disconnected. Check Node.js 18+ and Codex CLI availability; use Other methods if this host is unsupported.",
      }),
    );
    process.exitCode = 1;
  }
}
