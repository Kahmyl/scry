// Standalone installer: Node built-ins only. No package scripts, shell or OAuth credentials.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
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
  const server = servers?.scry_beta ?? servers?.scry;
  if (
    mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" ||
    Object.keys(servers ?? {}).length !== 1 ||
    server?.url !== endpoint ||
    server?.type !== "streamable-http"
  )
    fail("INVALID_MCP_ENDPOINT");
  const auth = server.extensions?.["com.openai"]?.auth;
  if (
    server.headers ||
    (auth &&
      (auth.type !== "oauth" ||
        auth.client?.mode !== "dcr" ||
        JSON.stringify(auth.baseScopes) !== '["scry:testing"]' ||
        JSON.stringify(auth.defaultScopes) !== '["scry:testing"]'))
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
async function unchangedOrMissing(path, expected, name) {
  const existing = await stat(path);
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink()) fail("EXISTING_SCRY_FILES_DIFFER");
  const bytes = await readFile(path);
  if (bytes.equals(expected)) return;
  // Migrate only exact files from the previously shipped 0.1.3 release.
  // Never overwrite user edits or accept a hash supplied by the network.
  if (
    name === "mcp.json" &&
    digest(bytes) === "8561f934e8d375392c3c0635c0fe30726c9cae818ef5a5145b6db980632b4447"
  )
    return;
  // URL-only predecessor/control uses the old global-colliding server name.
  if (
    name === "mcp.json" &&
    digest(bytes) === "560cc5e06e4d57b5e5225dcdd2f0117837c943cfca698dd8f89884b4a3dafbbc"
  )
    return;
  if (
    name === "plugin.json" &&
    digest(bytes) === "f57b9177d0278a78896f74f11e59046190e52f63cd8a604bbe203327f5494609"
  )
    return;
  fail("EXISTING_SCRY_FILES_DIFFER");
}

export function codexCommand({
  platform = process.platform,
  searchPath = process.env.PATH ?? "",
  exists = existsSync,
} = {}) {
  if (platform !== "win32") return { command: "codex", prefix: [] };
  for (const directory of searchPath
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)) {
    const native = win32.join(directory, "codex.exe");
    if (exists(native)) return { command: native, prefix: [] };
    // npm exposes a .cmd shim, which spawn(shell:false) cannot execute on
    // Windows. Run its standard Node entry point directly, without cmd.exe.
    const script = win32.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (exists(win32.join(directory, "codex.cmd")) && exists(script))
      return { command: process.execPath, prefix: [script] };
  }
  fail("CODEX_EXECUTABLE_NOT_FOUND");
}

export function codex(args) {
  const { command, prefix } = codexCommand();
  const result = spawnSync(command, [...prefix, ...args], {
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
  for (const [name, contents] of files)
    await unchangedOrMissing(join(plugin, name), contents, name);
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
    else if (!(await readFile(join(plugin, name))).equals(contents))
      await writeFile(join(plugin, name), contents, { mode: 0o644 });
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
  };
}

// Use the documented app-server inventory to prove package attribution before
// starting OAuth. A same-name global server is not this plugin's connection.
export async function pluginInventory() {
  const { command, prefix } = codexCommand();
  const child = spawn(command, [...prefix, "app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  const stop = () => {
    for (const item of pending.values()) item.reject(new Error("CODEX_INVENTORY_FAILED"));
    pending.clear();
  };
  child.on("error", stop);
  child.on("exit", stop);
  child.stdin.on("error", stop);
  lines.on("line", (line) => {
    if (line.length > 4 * 1024 * 1024) return stop();
    try {
      const message = JSON.parse(line);
      const item = pending.get(message.id);
      if (item) {
        pending.delete(message.id);
        if (message.error) item.reject(new Error("CODEX_INVENTORY_FAILED"));
        else item.resolve(message.result);
      }
    } catch {
      stop();
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CODEX_INVENTORY_TIMEOUT"));
      }, 20000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", {
      clientInfo: { name: "scry_setup", version: "1.0.0" },
      capabilities: { explicitGatewayOauth: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const servers = [];
    let cursor;
    const seen = new Set();
    do {
      const page = await request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        serverName: "scry_beta",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) fail("INVALID_CODEX_INVENTORY");
      // A stored OAuth entry is not a working connection. Retain readiness
      // booleans, never the tool catalog or raw errors/URLs from discovery.
      servers.push(
        ...page.data.map(({ name, pluginId, httpOrigin, authStatus, tools, toolsError }) => ({
          name,
          pluginId,
          httpOrigin,
          authStatus,
          discoveryFailed: Boolean(toolsError),
          authorizationRequired: requiresAuthorization(toolsError),
          projectListingAvailable: Object.values(tools ?? {}).some(
            (tool) => tool?.name === "list_projects",
          ),
        })),
      );
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) fail("INVALID_CODEX_INVENTORY");
      seen.add(cursor);
    } while (cursor);
    return servers;
  } finally {
    stop();
    child.kill();
    lines.close();
  }
}

export function login(name) {
  const { command, prefix } = codexCommand();
  // Codex owns the OAuth callback and credential storage and opens the default
  // browser on macOS, Windows and Linux. Keep its URL/token output out of chat.
  const result = spawnSync(
    command,
    [
      ...prefix,
      "mcp",
      "login",
      name,
      "--scopes",
      "scry:testing",
      "--oauth-client-registration",
      "dcr",
    ],
    {
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return !result.error && result.status === 0;
}

export function requiresAuthorization(error) {
  // Only the host's explicit authentication classification permits a new login.
  // Never expose raw discovery errors or turn a network/500 failure into consent.
  return (
    typeof error === "string" &&
    /^(?:MCP startup failed: )?OAuth authorization required$/.test(error.trim())
  );
}

export async function authorize({ inventory = pluginInventory, signIn = login } = {}) {
  const fallback = {
    status: "needs_attention",
    url: "codex://plugins/install/scry?marketplace=scry-beta",
    linkLabel: "Open Scry setup",
    message:
      "Open Scry setup using this link, click Connect, then sign in and choose your workspace. If this Codex version cannot show the connection, update Codex and run setup again.",
  };
  const unavailable = {
    status: "needs_attention",
    url: "https://scry.giize.com/support",
    linkLabel: "Contact Scry support",
    message:
      "Scry is installed, but its connection could not load. Setup is not complete. Try again shortly; if this continues, contact Scry support using this link.",
  };
  const select = (entries) => {
    const servers = entries.filter(
      (server) =>
        server.pluginId === "scry@scry-beta" && server.httpOrigin === "https://scry.giize.com",
    );
    return servers.length === 1 && /^[A-Za-z0-9_.:@/-]+$/.test(servers[0].name)
      ? servers[0]
      : undefined;
  };
  const ready = (server) =>
    server?.authStatus === "oAuth" &&
    !server.discoveryFailed &&
    server.projectListingAvailable === true;
  try {
    const server = select(await inventory());
    if (!server) return fallback;
    if (server.authStatus === "oAuth" && !server.authorizationRequired)
      return ready(server)
        ? {
            status: "authorized",
            message:
              "Scry is signed in and its tools loaded. Check workspace access before calling setup complete.",
          }
        : unavailable;
    if (!(await signIn(server.name))) return fallback;
    if (!ready(select(await inventory()))) return unavailable;
    return {
      status: "authorized",
      message:
        "Scry sign-in completed and its tools loaded. Check workspace access before calling setup complete.",
    };
  } catch {
    return fallback;
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)).catch(() => null))
) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== "--check")) fail("INVALID_ARGUMENTS");
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
    } else {
      const result = await install(data);
      console.log(JSON.stringify({ ...result, authorization: await authorize() }));
    }
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
