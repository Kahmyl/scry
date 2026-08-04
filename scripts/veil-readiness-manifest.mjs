import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const excluded = new Set(["docs/architecture/veil-readiness-ledger.json"]);
const excludedPrefixes = ["docs/architecture/evidence/"];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const include = (file) =>
  !excluded.has(file) && !excludedPrefixes.some((prefix) => file.startsWith(prefix));
const tracked = git(
  "diff",
  "HEAD",
  "--binary",
  "--",
  ".",
  ":(exclude)docs/architecture/veil-readiness-ledger.json",
  ":(exclude)docs/architecture/evidence/**",
);
const untracked = git("ls-files", "--others", "--exclude-standard")
  .split("\n")
  .filter(Boolean)
  .filter(include)
  .sort();
const contentManifest = untracked
  .map((file) => `${file}\0${createHash("sha256").update(readFileSync(file)).digest("hex")}\n`)
  .join("");
const report = {
  schemaVersion: 1,
  algorithm: "sha256-v1",
  exclusions: ["docs/architecture/veil-readiness-ledger.json", "docs/architecture/evidence/**"],
  baseCommit: git("rev-parse", "HEAD").trim(),
  branch: git("branch", "--show-current").trim(),
  trackedDiffSha256: createHash("sha256").update(tracked).digest("hex"),
  untrackedPathContentManifestSha256: createHash("sha256").update(contentManifest).digest("hex"),
  codeWorkingTreeEntryCount: git("status", "--short")
    .split("\n")
    .filter(Boolean)
    .filter((line) => include(line.slice(3))).length,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
