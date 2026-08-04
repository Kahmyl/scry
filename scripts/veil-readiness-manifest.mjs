import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const excluded = new Set(["docs/architecture/veil-readiness-ledger.json"]);
const excludedPrefixes = ["docs/architecture/evidence/"];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const include = (file) => {
  if (excluded.has(file) || excludedPrefixes.some((prefix) => file.startsWith(prefix)))
    return false;
  try {
    lstatSync(file);
    return true;
  } catch {
    // A tracked path deleted from the working tree is not part of its effective content.
    return false;
  }
};

// Hash the effective repository tree, not Git's transient staged/unstaged state.
// The same bytes therefore have the same identity before and after commit and
// on every branch or clean CI checkout.
const files = git("ls-files", "--cached", "--others", "--exclude-standard")
  .split("\n")
  .filter(Boolean)
  .filter(include)
  .sort();
const manifest = files
  .map((file) => {
    const metadata = lstatSync(file);
    const mode = metadata.isSymbolicLink() ? "120000" : metadata.mode & 0o111 ? "100755" : "100644";
    const content = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(file))
      : readFileSync(file);
    const digest = createHash("sha256").update(content).digest("hex");
    return `${file}\0${mode}\0${digest}\n`;
  })
  .join("");

const report = {
  schemaVersion: 2,
  algorithm: "sorted-path-mode-content-sha256-v1",
  exclusions: ["docs/architecture/veil-readiness-ledger.json", "docs/architecture/evidence/**"],
  sourceRevision: git("rev-parse", "HEAD").trim(),
  sourceBranch: git("branch", "--show-current").trim(),
  codeContentManifestSha256: createHash("sha256").update(manifest).digest("hex"),
  codeEntryCount: files.length,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
