import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { test } from "vitest";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";

test("all downloadable packages contain the same skills and public MCP endpoint, never credentials", async () => {
  execFileSync(process.execPath, [new URL("./build-plugins.mjs", import.meta.url).pathname]);
  const expectedSkills = ["scry-setup", "scry-test-web-app", "scry-review-results"];
  for (const client of ["codex", "claude", "cursor"]) {
    const files = unzipSync(
      await readFile(new URL(`../public/plugins/scry-${client}.zip`, import.meta.url)),
    );
    const text = Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => !path.startsWith("assets/"))
        .map(([path, value]) => [path, new TextDecoder().decode(value)]),
    );
    const metadata = JSON.parse(text["plugin.json"]);
    assert.equal(metadata.name, "scry");
    assert.match(metadata.version, /^\d+\.\d+\.\d+$/u);
    for (const skill of expectedSkills) assert.ok(text[`skills/${skill}/SKILL.md`]);
    assert.ok(files["assets/scry.png"].length > 0);
    const config = JSON.parse(text[client === "claude" ? ".mcp.json" : "mcp.json"]);
    assert.equal(config.mcpServers.scry.url, "https://scry.giize.com/mcp");
    assert.equal(config.mcpServers.scry.type, client === "claude" ? "http" : "streamable-http");
    assert.equal(config.mcpServers.scry.headers, undefined);
    if (client !== "claude")
      assert.deepEqual(config.mcpServers.scry.extensions["com.openai"].auth, {
        type: "oauth",
        client: { mode: "dcr" },
        baseScopes: ["scry:testing"],
        defaultScopes: ["scry:testing"],
        oidcEnabled: false,
      });
    for (const [path, value] of Object.entries(text)) {
      assert.ok(!path.includes("..") && !path.startsWith("/"));
      assert.doesNotMatch(
        value,
        /scry_mcp_[A-Za-z0-9_-]{15,}|-----BEGIN (?:RSA )?PRIVATE KEY|"clientSecret"\s*:/u,
      );
    }
    if (client === "claude")
      assert.equal(JSON.parse(text[".claude-plugin/plugin.json"]).name, "scry");
  }
  const first = await readFile(new URL("../public/plugins/scry-codex.zip", import.meta.url));
  execFileSync(process.execPath, [new URL("./build-plugins.mjs", import.meta.url).pathname]);
  assert.ok(
    first.equals(await readFile(new URL("../public/plugins/scry-codex.zip", import.meta.url))),
  );
});
