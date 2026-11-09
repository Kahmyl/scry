import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const source = new URL("../../../plugins/scry/", import.meta.url);
const output = new URL("../public/plugins/", import.meta.url);
const files = [
  "plugin.json",
  "mcp.json",
  "README.md",
  "skills/scry-setup/SKILL.md",
  "skills/scry-test-web-app/SKILL.md",
  "skills/scry-review-results/SKILL.md",
];
const base = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [file, new Uint8Array(await readFile(new URL(file, source)))]),
  ),
);
const metadata = JSON.parse(new TextDecoder().decode(base["plugin.json"]));
base["assets/scry.png"] = new Uint8Array(
  await readFile(new URL("../public/brand/scry-icon-192.png", import.meta.url)),
);
await mkdir(output, { recursive: true });
for (const client of ["codex", "chatgpt", "claude", "cursor"]) {
  const entries = { ...base };
  if (client === "claude") {
    const manifest = JSON.parse(new TextDecoder().decode(base["plugin.json"]));
    entries[".claude-plugin/plugin.json"] = strToU8(
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
      }),
    );
    entries[".mcp.json"] = strToU8(
      JSON.stringify({ mcpServers: { scry: { type: "http", url: "https://scry.giize.com/mcp" } } }),
    );
  }
  const archive = zipSync(entries, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") });
  await writeFile(new URL(`scry-${client}.zip`, output), archive);
  if (client === "codex") {
    const versionedArchive = `scry-codex-${metadata.version}.zip`;
    await writeFile(new URL(versionedArchive, output), archive);
    const checksum = createHash("sha256").update(archive).digest("hex");
    const marketplace = {
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
    await writeFile(
      new URL("scry-desktop-marketplace.json", output),
      JSON.stringify(marketplace, null, 2) + "\n",
    );
    await writeFile(
      new URL("scry-desktop-setup.txt", output),
      `Scry desktop / Codex private plugin setup

Install only Scry, preserving all other plugins, configuration and connections.
This is a local plugin installation, not a ChatGPT web or public directory install.
The user must complete account sign-in, workspace choice and consent themselves.
Do not request passwords or tokens in chat or approve consent on their behalf.

Package: https://scry.giize.com/plugins/${versionedArchive}
Version: ${metadata.version}
SHA-256: ${checksum}
Marketplace: https://scry.giize.com/plugins/scry-desktop-marketplace.json

1. Download the package as data. Verify its SHA-256 before extracting. Inspect the
   archive, reject absolute/traversal paths and symlinks, and inspect plugin.json,
   mcp.json and all three SKILL.md files. Expected plugin name: scry. Its only MCP
   endpoint is https://scry.giize.com/mcp, with OAuth dynamic client registration.
   There must be no account-specific App IDs, credentials, hooks or executable scripts.
   If the checksum, contents or endpoint differ, stop and explain; do not install.
2. Use a dedicated persistent per-user marketplace directory outside the current
   project, such as ~/.scry/marketplace. Do not overwrite an existing different
   marketplace. Put the inspected plugin at <root>/plugins/scry. Fetch and inspect
   the marketplace JSON, then save it at <root>/.agents/plugins/marketplace.json.
   It must name scry-beta and contain only the local scry plugin, pointing at
   ./plugins/scry, with AVAILABLE installation and ON_INSTALL authentication.
   If scry-beta is already registered at a different root, preserve it and stop
   to explain the conflict rather than replacing it or installing a second copy.
3. Check the installed CLI supports the following commands, then use the supported
   local marketplace and plugin install commands:
     codex plugin marketplace add <root> --json
     codex plugin add scry@scry-beta --json
   Inspect the returned installation result. Do not edit config.toml or grant
   blanket tool approvals. If these commands are unavailable, explain the host
   prerequisite instead of claiming installation; the user can use ChatGPT web
   archive upload or the manual connection method on Scry's Connections page.
4. Use the host's supported Scry account connection flow. Let the user sign in
   and choose their own workspace on Scry's consent page. If the host requires a
   new chat or app restart to expose tools, say so plainly. A local install does
   not establish a cloud connection, and installation alone is not verified access.
5. Once tools are available, call Scry's read-only list_projects tool. Report only
   projects returned for the authorized workspace. Do not start tests, create
   credentials, change the application, or claim success without that response.
   If no projects exist, direct the user to create a project in Scry.
`,
    );
  }
}
console.log(
  `Built four credential-free plugin packages and desktop setup in ${fileURLToPath(output)}`,
);
