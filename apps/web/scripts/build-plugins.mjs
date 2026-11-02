import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
base["assets/scry.png"] = new Uint8Array(
  await readFile(new URL("../public/brand/scry-icon-192.png", import.meta.url)),
);
await mkdir(output, { recursive: true });
for (const client of ["codex", "claude", "cursor"]) {
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
}
console.log(`Built three credential-free plugin packages in ${fileURLToPath(output)}`);
