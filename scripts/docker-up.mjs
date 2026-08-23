import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const commit = git(["rev-parse", "HEAD"]).trim();
const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
const trackedDiff = git(["diff", "--binary", "--no-ext-diff", "HEAD"]);
const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean)
  .sort();
const manifest = createHash("sha256").update(commit).update("\0").update(trackedDiff);
for (const path of untracked) {
  manifest.update("\0").update(path).update("\0");
  if (statSync(path).isFile()) manifest.update(readFileSync(path));
}

run("pnpm", ["verify:release-fingerprint"], process.env);
run("docker", ["compose", "up", "--build", "--wait"], {
  ...process.env,
  SCRY_GIT_COMMIT: commit,
  SCRY_SOURCE_DIRTY: status.length ? "true" : "false",
  SCRY_SOURCE_MANIFEST_SHA256: manifest.digest("hex"),
  SCRY_RUNTIME_VERSION: process.env.SCRY_RUNTIME_VERSION ?? `node-${process.version}`,
});

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
