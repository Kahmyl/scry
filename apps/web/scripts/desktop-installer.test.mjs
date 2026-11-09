import { afterEach, beforeAll, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, validatePackage } from "./desktop-installer.mjs";
import { createSetupCommand } from "./desktop-bootstrap.mjs";

let data;
const temporary = [];
beforeAll(async () => {
  execFileSync(process.execPath, [new URL("./build-plugins.mjs", import.meta.url).pathname]);
  data = JSON.parse(
    await readFile(new URL("../public/plugins/scry-desktop-package.json", import.meta.url), "utf8"),
  );
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
  await symlink(join(f.userDirectory, "other"), join(f.userDirectory, ".scry"));
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
