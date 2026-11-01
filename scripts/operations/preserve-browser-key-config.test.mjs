import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveBrowserKeyConfig } from "./preserve-browser-key-config.mjs";

const directory = mkdtempSync(join(tmpdir(), "scry-key-aliases-"));
const envPath = join(directory, "environment");
const original = `OTHER_CONFIG=unchanged\nBROWSER_V2_PROTECTED_KEYS_JSON='{"historical-id":"fictional-key"}'\nBROWSER_V2_PROTECTED_KEY_VERSION=historical-id\n`;
writeFileSync(envPath, original, { mode: 0o600 });
assert.deepEqual(preserveBrowserKeyConfig(envPath), { changed: false, pendingAliases: 2 });
assert.equal(readFileSync(envPath, "utf8"), original);
assert.equal(preserveBrowserKeyConfig(envPath, true).preservedAliases, 2);
assert.equal(readFileSync(`${envPath}.before-browser-key-aliases`, "utf8"), original);
assert.equal(lstatSync(envPath).mode & 0o777, 0o600);
assert.equal(lstatSync(`${envPath}.before-browser-key-aliases`).mode & 0o777, 0o600);
assert.ok(
  readFileSync(envPath, "utf8").includes(
    `SCRY_BROWSER_PROTECTED_KEYS_JSON='{"historical-id":"fictional-key"}'`,
  ),
);
assert.ok(readFileSync(envPath, "utf8").includes("SCRY_BROWSER_PROTECTED_KEY_ID=historical-id"));
assert.deepEqual(preserveBrowserKeyConfig(envPath, true), { changed: false, pendingAliases: 0 });
writeFileSync(envPath, `${original}SCRY_BROWSER_PROTECTED_KEY_ID=other-id\n`);
assert.throws(() => preserveBrowserKeyConfig(envPath, true), /conflicts/);
writeFileSync(envPath, `${original}BROWSER_V2_PROTECTED_KEY_VERSION=duplicate\n`);
assert.throws(() => preserveBrowserKeyConfig(envPath, true), /duplicate/);
writeFileSync(envPath, "OTHER_CONFIG=unchanged\n");
assert.throws(() => preserveBrowserKeyConfig(envPath, true), /missing/);
writeFileSync(envPath, original);
assert.throws(() => preserveBrowserKeyConfig(envPath, true), /backup already exists/);
chmodSync(envPath, 0o644);
assert.throws(() => preserveBrowserKeyConfig(envPath, true), /private regular/);
chmodSync(envPath, 0o600);
const alias = join(directory, "symlink");
symlinkSync(envPath, alias);
assert.throws(() => preserveBrowserKeyConfig(alias, true), /private regular/);
console.log(
  "Browser key configuration preservation: dry-run, exact bytes/IDs, private backup, replay, conflicts, duplicates, missing values and symlink refusal passed.",
);
