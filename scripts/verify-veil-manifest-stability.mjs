import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const current = JSON.parse(
  execFileSync("node", ["scripts/veil-readiness-manifest.mjs"], { encoding: "utf8" }),
);
const files = git("ls-files", "--cached", "--others", "--exclude-standard")
  .split("\n")
  .filter(Boolean);
const fixture = mkdtempSync(join(tmpdir(), "scry-veil-manifest-"));
try {
  for (const file of files) {
    const target = join(fixture, file);
    mkdirSync(dirname(target), { recursive: true });
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink()) symlinkSync(readlinkSync(file), target);
    else {
      copyFileSync(file, target);
      chmodSync(target, metadata.mode);
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync("git", ["config", "user.email", "verification@scry.invalid"], { cwd: fixture });
  execFileSync("git", ["config", "user.name", "Scry Verification"], { cwd: fixture });
  execFileSync("git", ["add", "."], { cwd: fixture });
  execFileSync("git", ["commit", "-qm", "manifest stability fixture"], { cwd: fixture });
  const committed = JSON.parse(
    execFileSync("node", ["scripts/veil-readiness-manifest.mjs"], {
      cwd: fixture,
      encoding: "utf8",
    }),
  );
  if (
    current.codeContentManifestSha256 !== committed.codeContentManifestSha256 ||
    current.codeEntryCount !== committed.codeEntryCount
  )
    throw new Error("Veil code identity changes between an effective tree and its clean commit");
  console.log(
    `Veil manifest stability verified across dirty-tree and clean-commit states (${current.codeEntryCount} entries).`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
