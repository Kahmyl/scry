import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function deriveRepositorySourceIdentity(repositoryRootInput = process.cwd()) {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const commitSha = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const trackedDiff = git(repositoryRoot, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const untracked = git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const manifest = createHash("sha256").update(commitSha).update("\0").update(trackedDiff);

  for (const relativePath of untracked) {
    manifest.update("\0").update(relativePath).update("\0");
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (statSync(absolutePath).isFile()) manifest.update(readFileSync(absolutePath));
  }

  return {
    commitSha,
    dirty: status.length > 0,
    manifestSha256: manifest.digest("hex"),
  };
}

export function assertAuthoritativeSourceIdentity(actual, expected) {
  if (actual.dirty) throw new Error("AUTHORITATIVE_SOURCE_IDENTITY_DIRTY");
  if (actual.commitSha !== expected.commitSha)
    throw new Error("AUTHORITATIVE_SOURCE_IDENTITY_COMMIT_MISMATCH");
  if (actual.manifestSha256 !== expected.manifestSha256)
    throw new Error("AUTHORITATIVE_SOURCE_IDENTITY_MANIFEST_MISMATCH");
}

export function assertRuntimeSourceIdentity(runtime, expected) {
  if (
    runtime.gitCommit !== expected.commitSha ||
    runtime.dirty !== expected.dirty ||
    runtime.manifestSha256 !== expected.manifestSha256
  )
    throw new Error("AUTHORITATIVE_RUNTIME_SOURCE_IDENTITY_MISMATCH");
}

export function sourceIdentityEnvironment(identity) {
  return {
    SCRY_GIT_COMMIT: identity.commitSha,
    SCRY_SOURCE_DIRTY: identity.dirty ? "true" : "false",
    SCRY_SOURCE_MANIFEST_SHA256: identity.manifestSha256,
  };
}

function git(repositoryRoot, args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(" ")} failed with ${result.status}`);
  return result.stdout;
}
