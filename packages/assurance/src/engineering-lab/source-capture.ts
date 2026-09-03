import { access, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, prettyJson, runGit, sha256 } from "./internal.js";
import type {
  EngineeringLabCapturedFile,
  EngineeringLabExcludedFile,
  EngineeringLabSourceCapture,
  EngineeringLabSourceFingerprint,
  EngineeringLabUntrackedPolicy,
} from "./types.js";

const MAX_TRACKED_PATCH_BYTES = 64 * 1024 * 1024;

const GENERATED_SEGMENTS = new Set([
  ".cache",
  ".next",
  "artifacts",
  "browser-profile",
  "browser-profiles",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const SECRET_FILE =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:key|pem|p12|pfx))$/i;
const DATABASE_FILE = /\.(?:db|sqlite|sqlite3)$/i;

export async function captureEngineeringLabSource(
  sourceRootInput: string,
  artifactRootInput: string,
  policy: EngineeringLabUntrackedPolicy,
): Promise<EngineeringLabSourceCapture> {
  validateUntrackedPolicy(policy);

  const sourceRoot = await realpath(sourceRootInput);
  const repositoryRoot = (await runGit(sourceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();

  if ((await realpath(repositoryRoot)) !== sourceRoot) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_SOURCE_ROOT_MUST_BE_REPOSITORY_ROOT");
  }

  const artifactRoot = await canonicalProspectivePath(artifactRootInput);

  if (isWithin(sourceRoot, artifactRoot)) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_ARTIFACT_ROOT_INSIDE_SOURCE");
  }

  await mkdir(path.join(artifactRoot, "capture", "blobs"), { recursive: true });

  const initialFingerprint = await fingerprintEngineeringLabSource(sourceRoot);
  const headSha = initialFingerprint.headSha;
  const treeSha = (await runGit(sourceRoot, ["rev-parse", `${headSha}^{tree}`])).stdout.trim();
  const trackedPatch = await captureTrackedPatch(sourceRoot);
  const trackedPatchRef = "capture/tracked.patch";
  const trackedPatchPath = path.join(artifactRoot, trackedPatchRef);

  await writeImmutable(trackedPatchPath, trackedPatch);

  const untrackedPaths = await listUntrackedPaths(sourceRoot);
  const selected: EngineeringLabCapturedFile[] = [];
  const excluded: EngineeringLabExcludedFile[] = [];
  let totalBytes = 0;

  for (const relativePath of untrackedPaths) {
    const exclusion = classifyUntrackedPath(relativePath, policy);

    if (exclusion) {
      excluded.push({ path: relativePath, reason: exclusion });
      continue;
    }

    const absolutePath = safeJoin(sourceRoot, relativePath);
    const stat = await lstat(absolutePath);

    if (!stat.isFile()) {
      excluded.push({ path: relativePath, reason: "unsupported_file_type" });
      continue;
    }

    if (stat.size > policy.maxFileBytes) {
      excluded.push({ path: relativePath, reason: "file_too_large" });
      continue;
    }

    if (totalBytes + stat.size > policy.maxTotalBytes) {
      excluded.push({ path: relativePath, reason: "total_size_limit" });
      continue;
    }

    const content = await readFile(absolutePath);
    const digest = sha256(content);
    const blobRef = `capture/blobs/${digest}`;
    const blobPath = path.join(artifactRoot, blobRef);

    try {
      await writeImmutable(blobPath, content);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }

    selected.push({
      path: relativePath,
      digest,
      bytes: stat.size,
      executable: (stat.mode & 0o111) !== 0,
      blobRef,
    });
    totalBytes += stat.size;
  }

  const bundleFacts = {
    selected,
    excluded,
    policy,
  };
  const untrackedBundleDigest = sha256(canonicalJson(bundleFacts));
  const untrackedManifestRef = "capture/untracked-manifest.json";

  await writeImmutable(
    path.join(artifactRoot, untrackedManifestRef),
    prettyJson({
      schemaVersion: 1,
      digest: untrackedBundleDigest,
      ...bundleFacts,
    }),
  );

  return {
    sourceRoot,
    headSha,
    treeSha,
    branch: initialFingerprint.branch,
    trackedPatchRef,
    trackedPatchDigest: sha256(trackedPatch),
    trackedPatchBytes: Buffer.byteLength(trackedPatch),
    untrackedManifestRef,
    untrackedBundleDigest,
    selectedUntrackedFiles: selected,
    excludedUntrackedFiles: excluded,
    sourceFingerprint: await fingerprintCapturedSource(sourceRoot, selected),
  };
}

export async function fingerprintEngineeringLabSource(
  sourceRootInput: string,
  selectedUntrackedPaths: readonly string[] = [],
): Promise<EngineeringLabSourceFingerprint> {
  const sourceRoot = await realpath(sourceRootInput);
  const headSha = (await runGit(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const branchResult = await runGit(sourceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true,
  });
  const trackedPatch = await captureTrackedPatch(sourceRoot);
  const status = await runGit(
    sourceRoot,
    ["status", "--porcelain=v2", "--untracked-files=all", "-z"],
    { maxCaptureBytes: MAX_TRACKED_PATCH_BYTES },
  );

  if (status.stdoutTruncated) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_STATUS_INVENTORY_TOO_LARGE");
  }

  const untrackedPaths = await listUntrackedPaths(sourceRoot);
  const untrackedMetadata = await Promise.all(
    untrackedPaths.map(async (relativePath) => {
      const file = await lstat(safeJoin(sourceRoot, relativePath));

      return {
        path: relativePath,
        bytes: file.size,
        mode: file.mode,
        modifiedAtMs: file.mtimeMs,
        type: file.isFile() ? "file" : file.isSymbolicLink() ? "symlink" : "other",
      };
    }),
  );
  const selectedUntrackedContent = await Promise.all(
    [...selectedUntrackedPaths]
      .sort((left, right) => left.localeCompare(right))
      .map(async (relativePath) => ({
        path: normalizeRelativePath(relativePath),
        digest: sha256(await readFile(safeJoin(sourceRoot, relativePath))),
      })),
  );

  return {
    headSha,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
    trackedPatchDigest: sha256(trackedPatch),
    statusDigest: sha256(status.stdout),
    untrackedPathDigest: sha256(canonicalJson(untrackedPaths)),
    untrackedMetadataDigest: sha256(canonicalJson(untrackedMetadata)),
    selectedUntrackedContentDigest: sha256(canonicalJson(selectedUntrackedContent)),
  };
}

export function compareEngineeringLabSourceFingerprints(
  before: EngineeringLabSourceFingerprint,
  after: EngineeringLabSourceFingerprint,
): readonly string[] {
  const mismatches: string[] = [];

  for (const key of [
    "headSha",
    "branch",
    "trackedPatchDigest",
    "statusDigest",
    "untrackedPathDigest",
    "untrackedMetadataDigest",
    "selectedUntrackedContentDigest",
  ] as const) {
    if (before[key] !== after[key]) {
      mismatches.push(key);
    }
  }

  return mismatches;
}

async function fingerprintCapturedSource(
  sourceRoot: string,
  selected: readonly EngineeringLabCapturedFile[],
): Promise<EngineeringLabSourceFingerprint> {
  const fingerprint = await fingerprintEngineeringLabSource(
    sourceRoot,
    selected.map(({ path: relativePath }) => relativePath),
  );
  const capturedDigest = sha256(
    canonicalJson(
      selected
        .map(({ path: relativePath, digest }) => ({ path: relativePath, digest }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );

  if (fingerprint.selectedUntrackedContentDigest !== capturedDigest) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_SOURCE_CHANGED_DURING_CAPTURE");
  }

  return fingerprint;
}

async function captureTrackedPatch(sourceRoot: string): Promise<string> {
  const result = await runGit(sourceRoot, ["diff", "--binary", "--full-index", "HEAD", "--"], {
    maxCaptureBytes: MAX_TRACKED_PATCH_BYTES,
  });

  if (result.stdoutTruncated) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_TRACKED_PATCH_TOO_LARGE");
  }

  return result.stdout;
}

async function listUntrackedPaths(sourceRoot: string): Promise<readonly string[]> {
  const result = await runGit(
    sourceRoot,
    ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { maxCaptureBytes: MAX_TRACKED_PATCH_BYTES },
  );

  if (result.stdoutTruncated) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_UNTRACKED_INVENTORY_TOO_LARGE");
  }

  return result.stdout
    .split("\u0000")
    .filter(Boolean)
    .map(normalizeRelativePath)
    .sort((left, right) => left.localeCompare(right));
}

function classifyUntrackedPath(
  relativePath: string,
  policy: EngineeringLabUntrackedPolicy,
): EngineeringLabExcludedFile["reason"] | null {
  const segments = relativePath.split("/");
  const basename = segments.at(-1) ?? "";

  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment)) || DATABASE_FILE.test(basename)) {
    return "generated_or_artifact";
  }

  if (SECRET_FILE.test(basename)) {
    return "secret_or_credential";
  }

  const allowed = policy.allowedPathPrefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );

  return allowed ? null : "not_explicitly_allowed";
}

function validateUntrackedPolicy(policy: EngineeringLabUntrackedPolicy): void {
  if (
    policy.allowedPathPrefixes.length === 0 ||
    !Number.isSafeInteger(policy.maxFileBytes) ||
    policy.maxFileBytes < 1 ||
    !Number.isSafeInteger(policy.maxTotalBytes) ||
    policy.maxTotalBytes < policy.maxFileBytes
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_UNTRACKED_POLICY_INVALID");
  }

  for (const prefix of policy.allowedPathPrefixes) {
    normalizeRelativePath(prefix);
  }
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/");

  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`ASSURANCE_ENGINEERING_LAB_PATH_INVALID:${input}`);
  }

  return normalized;
}

function safeJoin(root: string, relativePath: string): string {
  const target = path.resolve(root, normalizeRelativePath(relativePath));

  if (!isWithin(root, target) || target === root) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_PATH_ESCAPE");
  }

  return target;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalProspectivePath(input: string): Promise<string> {
  let cursor = path.resolve(input);
  const missingSegments: string[] = [];

  while (true) {
    try {
      await access(cursor);
      break;
    } catch {
      const parent = path.dirname(cursor);

      if (parent === cursor) {
        throw new Error("ASSURANCE_ENGINEERING_LAB_ARTIFACT_ROOT_UNRESOLVABLE");
      }

      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  return path.join(await realpath(cursor), ...missingSegments);
}

async function writeImmutable(target: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { flag: "wx", mode: 0o444 });
  await chmod(target, 0o444);
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
