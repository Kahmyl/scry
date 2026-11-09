import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { createSetupCommand } from "./desktop-bootstrap.mjs";

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
const installer = await readFile(new URL("./desktop-installer.mjs", import.meta.url));
const installerChecksum = createHash("sha256").update(installer).digest("hex");
await writeFile(new URL("scry-desktop-install.mjs", output), installer);
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
      new URL("scry-desktop-package.json", output),
      JSON.stringify({
        version: metadata.version,
        files: Object.entries(base).map(([path, bytes]) => ({
          path,
          base64: Buffer.from(bytes).toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
      }) + "\n",
    );
    await writeFile(
      new URL("scry-desktop-setup.txt", output),
      `Scry desktop / Codex fast setup

Run this one tested command. It verifies the installer checksum, checks package
integrity and manifests, preserves existing connections, and installs through
supported Codex plugin commands. Do not generate another installer or repeat
the checks manually. Requires Node.js 18+ and Codex CLI.

${createSetupCommand(installerChecksum)}

After installation, use the host's plugin Connect action if needed. The customer
completes sign-in and workspace consent. Do not log into an existing bare-name
MCP server or claim access until read-only list_projects succeeds. Do not start tests.

Manual archive: https://scry.giize.com/plugins/${versionedArchive}
Version: ${metadata.version}
Archive SHA-256: ${checksum}
`,
    );
  }
}
console.log(
  `Built four credential-free plugin packages and desktop setup in ${fileURLToPath(output)}`,
);
