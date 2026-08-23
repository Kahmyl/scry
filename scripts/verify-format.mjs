import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";

const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (listed.status !== 0) throw new Error(listed.stderr || "Unable to list tracked files");

const files = listed.stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => !lstatSync(file).isSymbolicLink());
const result = spawnSync("pnpm", ["exec", "prettier", "--check", "--ignore-unknown", ...files], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
