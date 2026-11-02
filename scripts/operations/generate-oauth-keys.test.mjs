import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

test("OAuth key generation writes a private file without printing or overwriting keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "scry-oauth-keys-"));
  const target = join(directory, "private.env");
  const script = new URL("./generate-oauth-keys.mjs", import.meta.url).pathname;
  try {
    const output = execFileSync(process.execPath, [script, "--out", target], { encoding: "utf8" });
    const content = readFileSync(target, "utf8");
    const values = Object.fromEntries(
      content
        .trim()
        .split("\n")
        .map((line) => {
          const split = line.indexOf("=");
          return [line.slice(0, split), JSON.parse(line.slice(split + 2, -1))];
        }),
    );
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.ok(values.SCRY_OAUTH_COOKIE_KEYS_JSON[0].length >= 32);
    const key = values.SCRY_OAUTH_JWKS_JSON.keys[0];
    assert.equal(createPrivateKey({ key, format: "jwk" }).asymmetricKeyType, "rsa");
    assert.ok(!output.includes(key.d) && !output.includes(values.SCRY_OAUTH_COOKIE_KEYS_JSON[0]));
    assert.equal(spawnSync(process.execPath, [script, "--out", target]).status, 1);
    assert.equal(readFileSync(target, "utf8"), content);
  } finally {
    // Only this test's uniquely created fixture directory is removed.
    rmSync(directory, { recursive: true });
  }
});
