import { afterEach, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorize,
  codexCommand,
  install,
  validatePackage,
  requiresAuthorization,
} from "./desktop-installer.mjs";
import { createSetupCommand } from "./desktop-bootstrap.mjs";

let data;
const temporary = [];
beforeAll(async () => {
  // Build this fixture from source without competing with the archive test's output files.
  const root = new URL("../../../plugins/scry/", import.meta.url);
  const names = [
    "plugin.json",
    "mcp.json",
    "README.md",
    "skills/scry-setup/SKILL.md",
    "skills/scry-test-web-app/SKILL.md",
    "skills/scry-review-results/SKILL.md",
  ];
  const entries = await Promise.all(
    // Match the Linux-built published release, independent of Git checkout EOLs.
    names.map(async (path) => [
      path,
      Buffer.from((await readFile(new URL(path, root), "utf8")).replaceAll("\r\n", "\n")),
    ]),
  );
  entries.push([
    "assets/scry.png",
    await readFile(new URL("../public/brand/scry-icon-192.png", import.meta.url)),
  ]);
  data = {
    version: JSON.parse(entries.find(([path]) => path === "plugin.json")[1].toString()).version,
    files: entries.map(([path, contents]) => ({
      path,
      base64: contents.toString("base64"),
      sha256: createHash("sha256").update(contents).digest("hex"),
    })),
  };
});
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const userDirectory = await mkdtemp(join(tmpdir(), "scry installer "));
  temporary.push(userDirectory);
  const calls = [];
  let registered = false;
  const run = (args) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "list")
      return {
        marketplaces: registered
          ? [{ name: "scry-beta", root: join(userDirectory, ".scry/marketplace") }]
          : [],
      };
    if (args[1] === "marketplace" && args[2] === "add") {
      registered = true;
      return {};
    }
    return { pluginId: "scry@scry-beta", version: data.version };
  };
  return { userDirectory, calls, run };
}
function changeFile(copy, name, transform) {
  const entry = copy.files.find((item) => item.path === name);
  const text = transform(Buffer.from(entry.base64, "base64").toString());
  entry.base64 = Buffer.from(text).toString("base64");
  entry.sha256 = createHash("sha256").update(text).digest("hex");
}
test("one deterministic install preserves unrelated state, uses only three CLI calls and repeats safely", async () => {
  const f = await fixture();
  await writeFile(join(f.userDirectory, "unrelated-config"), "keep this unchanged");
  const result = await install(data, f);
  expect(result.status).toBe("installed");
  expect(result.elapsedMs).toBeLessThan(15000);
  expect(f.calls).toEqual([
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", join(f.userDirectory, ".scry/marketplace"), "--json"],
    ["plugin", "add", "scry@scry-beta", "--json"],
  ]);
  expect(await readFile(join(f.userDirectory, "unrelated-config"), "utf8")).toBe(
    "keep this unchanged",
  );
  const file = join(f.userDirectory, ".scry/marketplace/plugins/scry/mcp.json");
  const modified = (await stat(file)).mtimeMs;
  f.calls.length = 0;
  await install(data, f);
  expect(f.calls).toHaveLength(2);
  expect((await stat(file)).mtimeMs).toBe(modified);
  expect(f.calls.every((args) => args[0] === "plugin")).toBe(true);
});
test("rejects tampered bytes, traversal, unexpected files, hooks and other endpoints before any installation", async () => {
  const f = await fixture();
  const bad = structuredClone(data);
  bad.files[0].base64 += "AAAA";
  expect(() => validatePackage(bad)).toThrow("PACKAGE_CHECKSUM_MISMATCH");
  const traversal = structuredClone(data);
  traversal.files[0].path = "../config.toml";
  expect(() => validatePackage(traversal)).toThrow("INVALID_PACKAGE_PATH");
  const extra = structuredClone(data);
  extra.files.push({ path: "hooks/start.sh" });
  expect(() => validatePackage(extra)).toThrow("INVALID_PACKAGE");
  const hooks = structuredClone(data);
  changeFile(hooks, "plugin.json", (text) => {
    const manifest = JSON.parse(text);
    manifest.extensions["com.openai"].hooks = "./hooks.json";
    return JSON.stringify(manifest);
  });
  await expect(install(hooks, f)).rejects.toThrow("INVALID_PLUGIN_MANIFEST");
  const endpoint = structuredClone(data);
  changeFile(endpoint, "mcp.json", (text) =>
    text.replace("https://scry.giize.com/mcp", "https://other.example/mcp"),
  );
  await expect(install(endpoint, f)).rejects.toThrow("INVALID_MCP_ENDPOINT");
  expect(f.calls).toEqual([]);
});
test("preserves conflicting catalogs, modified files and symlink targets", async () => {
  const f = await fixture();
  await expect(
    install(data, {
      ...f,
      run: () => ({ marketplaces: [{ name: "scry-beta", root: "/different/root" }] }),
    }),
  ).rejects.toThrow("SCRY_MARKETPLACE_CONFLICT");
  await mkdir(join(f.userDirectory, "other"));
  await symlink(join(f.userDirectory, "other"), join(f.userDirectory, ".scry"), "junction");
  await expect(install(data, f)).rejects.toThrow("UNSAFE_INSTALL_DIRECTORY");
  await rm(join(f.userDirectory, ".scry"));
  await install(data, f);
  const file = join(f.userDirectory, ".scry/marketplace/plugins/scry/mcp.json");
  await writeFile(file, "do not replace");
  await expect(install(data, f)).rejects.toThrow("EXISTING_SCRY_FILES_DIFFER");
  expect(await readFile(file, "utf8")).toBe("do not replace");
});
test("does not claim success after a CLI failure or an unexpected install result", async () => {
  const f = await fixture();
  await expect(
    install(data, {
      ...f,
      run: () => {
        throw new Error("CODEX_COMMAND_FAILED");
      },
    }),
  ).rejects.toThrow("CODEX_COMMAND_FAILED");
  await expect(
    install(data, { ...f, run: (args) => (args[2] === "list" ? { marketplaces: [] } : {}) }),
  ).rejects.toThrow("INSTALL_NOT_CONFIRMED");
});
test("bootstrap verifies the exact installer before executing and contains no ad hoc package code", async () => {
  const source = await readFile(new URL("./desktop-installer.mjs", import.meta.url));
  const hash = createHash("sha256").update(source).digest("hex");
  const command = createSetupCommand(hash);
  expect(command).toContain(hash);
  expect(command.indexOf("checksum mismatch")).toBeLessThan(
    command.indexOf("spawnSync(process.execPath"),
  );
  expect(command).not.toContain("python");
  expect(command).not.toContain("config.toml");
  expect(() => createSetupCommand("not a digest")).toThrow();
});

test("the executable starts through a symlinked path and --check never installs", async () => {
  const f = await fixture();
  const real = join(f.userDirectory, "actual");
  const alias = join(f.userDirectory, "alias");
  await mkdir(real);
  await symlink(real, alias, "junction");
  await writeFile(
    join(real, "installer.mjs"),
    await readFile(new URL("./desktop-installer.mjs", import.meta.url)),
  );
  const preload = join(f.userDirectory, "fixture-fetch.mjs");
  await writeFile(
    preload,
    `globalThis.fetch = async () => ({ok:true,headers:new Headers(),json:async()=>(${JSON.stringify(data)})});`,
  );
  const child = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, join(alias, "installer.mjs"), "--check"],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).not.toBe("");
  expect(JSON.parse(child.stdout)).toEqual({
    status: "validated",
    version: data.version,
    writes: false,
  });
  await expect(stat(join(f.userDirectory, ".scry"))).rejects.toMatchObject({ code: "ENOENT" });
  const invalid = spawnSync(process.execPath, [join(alias, "installer.mjs"), "--unknown"], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stderr).code).toBe("INVALID_ARGUMENTS");
});

test("the actual bootstrap rejects an empty successful process and accepts installation confirmation", async () => {
  const f = await fixture();
  for (const source of [
    "",
    'console.log(JSON.stringify({status:"installed",pluginId:"scry@scry-beta"}));',
  ]) {
    const preload = join(f.userDirectory, "bootstrap-fetch.mjs");
    await writeFile(
      preload,
      `globalThis.fetch = async () => ({ok:true,arrayBuffer:async()=>Buffer.from(${JSON.stringify(source)})});`,
    );
    const command = createSetupCommand(createHash("sha256").update(source).digest("hex"));
    const script = command.slice('node --input-type=module -e "'.length, -1);
    const child = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(child.status, child.stderr).toBe(source ? 0 : 1);
    if (source) expect(JSON.parse(child.stdout).status).toBe("installed");
    else expect(child.stdout).toBe("");
  }
});

test("authorization targets only the attributed plugin, opens sign-in and distinguishes consent from installation", async () => {
  const calls = [];
  const server = {
    name: "plugin_scry_scry",
    pluginId: "scry@scry-beta",
    httpOrigin: "https://scry.giize.com",
    authStatus: "notLoggedIn",
    projectListingAvailable: true,
    discoveryFailed: false,
  };
  const signIn = async (name) => {
    calls.push(name);
    server.authStatus = "oAuth";
    return true;
  };
  const result = await authorize({
    inventory: async () => [
      { ...server, name: "scry", pluginId: null, authStatus: "oAuth" },
      server,
    ],
    signIn,
  });
  expect(calls).toEqual([server.name]);
  expect(result.status).toBe("authorized");
  calls.length = 0;
  for (const inventory of [
    async () => [{ ...server, pluginId: null }],
    async () => [{ ...server, httpOrigin: "https://another.example" }],
    async () => [server, server],
    async () => {
      throw new Error("private diagnostic must not escape");
    },
  ]) {
    const fallback = await authorize({ inventory, signIn });
    expect(fallback.status).toBe("needs_attention");
    expect(fallback.url).toBe("codex://plugins/install/scry?marketplace=scry-beta");
    expect(JSON.stringify(fallback)).not.toContain("private diagnostic");
  }
  expect(calls).toEqual([]);
  expect(
    (
      await authorize({
        inventory: async () => [{ ...server, authStatus: "notLoggedIn" }],
        signIn: async () => false,
      })
    ).status,
  ).toBe("needs_attention");
  expect(
    (await authorize({ inventory: async () => [{ ...server, authStatus: "oAuth" }], signIn }))
      .status,
  ).toBe("authorized");
  expect(calls).toEqual([]);
});

test("stored OAuth and a successful login never count as ready when discovery fails", async () => {
  const server = {
    name: "scry_beta",
    pluginId: "scry@scry-beta",
    httpOrigin: "https://scry.giize.com",
    authStatus: "oAuth",
    discoveryFailed: true,
    projectListingAvailable: false,
  };
  let loginCalls = 0;
  const signIn = async () => {
    loginCalls++;
    return true;
  };
  const stale = await authorize({ inventory: async () => [server], signIn });
  expect(stale.status).toBe("needs_attention");
  expect(stale.linkLabel).toBe("Contact Scry support");
  expect(stale.message).not.toContain("already signed in");
  expect(loginCalls).toBe(0);
  let reads = 0;
  const afterLogin = await authorize({
    inventory: async () => [{ ...server, authStatus: ++reads === 1 ? "notLoggedIn" : "oAuth" }],
    signIn,
  });
  expect(loginCalls).toBe(1);
  expect(reads).toBe(2);
  expect(afterLogin.status).toBe("needs_attention");
  const noCatalog = await authorize({
    inventory: async () => [{ ...server, discoveryFailed: false }],
    signIn,
  });
  expect(noCatalog.status).toBe("needs_attention");
});

test("reconnects a rejected stored OAuth credential once, only for the attributed plugin", async () => {
  const server = {
    name: "scry_beta",
    pluginId: "scry@scry-beta",
    httpOrigin: "https://scry.giize.com",
    authStatus: "oAuth",
    discoveryFailed: true,
    projectListingAvailable: false,
    authorizationRequired: true,
  };
  let reads = 0,
    logins = 0;
  const result = await authorize({
    inventory: async () => [
      {
        ...server,
        ...(++reads > 1
          ? { authorizationRequired: false, discoveryFailed: false, projectListingAvailable: true }
          : {}),
      },
    ],
    signIn: async (name) => {
      expect(name).toBe("scry_beta");
      logins++;
      return true;
    },
  });
  expect(result.status).toBe("authorized");
  expect(logins).toBe(1);
  expect(reads).toBe(2);
  logins = 0;
  expect(
    (
      await authorize({
        inventory: async () => [server],
        signIn: async () => {
          logins++;
          return true;
        },
      })
    ).status,
  ).toBe("needs_attention");
  expect(logins).toBe(1);
  expect(
    (
      await authorize({
        inventory: async () => [{ ...server, pluginId: null }],
        signIn: async () => {
          logins++;
          return true;
        },
      })
    ).status,
  ).toBe("needs_attention");
  expect(logins).toBe(1);
});

test("only classifies an explicit host authorization-required result as reconnectable", () => {
  expect(requiresAuthorization("MCP startup failed: OAuth authorization required")).toBe(true);
  expect(requiresAuthorization("OAuth authorization required")).toBe(true);
  for (const value of [
    undefined,
    null,
    {},
    "network error",
    "HTTP 401",
    "OAuth metadata discovery failed",
    "OAuth authorization required: private diagnostic",
  ])
    expect(requiresAuthorization(value)).toBe(false);
});

test("Windows uses native executables or the npm Node entry point without a shell", () => {
  const root = "C:\\Users\\Friend & Family\\AppData\\Roaming\\npm";
  const native = root + "\\codex.exe";
  expect(
    codexCommand({ platform: "win32", searchPath: root, exists: (p) => p === native }),
  ).toEqual({ command: native, prefix: [] });
  const script = root + "\\node_modules\\@openai\\codex\\bin\\codex.js";
  expect(
    codexCommand({
      platform: "win32",
      searchPath: root,
      exists: (p) => [root + "\\codex.cmd", script].includes(p),
    }),
  ).toEqual({ command: process.execPath, prefix: [script] });
  expect(() => codexCommand({ platform: "win32", searchPath: root, exists: () => false })).toThrow(
    "CODEX_EXECUTABLE_NOT_FOUND",
  );
});

test.skipIf(process.platform !== "win32")(
  "the published bootstrap command executes in Windows PowerShell with a path containing spaces",
  async () => {
    const f = await fixture();
    const source =
      'console.log(JSON.stringify({status:"installed",pluginId:"scry@scry-beta",authorization:{status:"needs_attention"}}));';
    const preload = join(f.userDirectory, "mock download.mjs");
    await writeFile(
      preload,
      `globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>Buffer.from(${JSON.stringify(source)})});`,
    );
    const command = createSetupCommand(createHash("sha256").update(source).digest("hex"));
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        // Windows runner process startup is outside the installer timing contract.
        // Keep a bounded allowance for PowerShell + two Node processes.
        timeout: 30000,
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).authorization.status).toBe("needs_attention");
  },
  45000,
);

test("migrates only the exact shipped MCP file and preserves user modifications", async () => {
  const f = await fixture();
  await install(data, f);
  const compatible = structuredClone(data);
  changeFile(compatible, "mcp.json", (text) => {
    const mcp = JSON.parse(text);
    delete mcp.mcpServers.scry.extensions;
    return JSON.stringify(mcp, null, 2) + "\n";
  });
  await install(compatible, f);
  const path = join(f.userDirectory, ".scry/marketplace/plugins/scry/mcp.json");
  expect(JSON.parse(await readFile(path, "utf8")).mcpServers.scry.extensions).toBeUndefined();
  await writeFile(path, "my custom connection");
  await expect(install(compatible, f)).rejects.toThrow("EXISTING_SCRY_FILES_DIFFER");
  expect(await readFile(path, "utf8")).toBe("my custom connection");
});
