import fs from "node:fs";
import path from "node:path";

export const STATIC_GATES = Object.freeze([
  "verify:agent-skills",
  "verify:direct-browser-boundary",
  "verify:execution-kernel-boundary",
  "verify:playwright",
  "verify:privacy-foundation",
  "verify:release-fingerprint",
  "verify:repository-topology",
  "verify:subsystem-boundaries",
]);

const GLOBAL_EXACT = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "tsconfig.base.json",
]);

const GLOBAL_PREFIXES = [".github/workflows/", "scripts/", "ops/"];

function normalize(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function discoverWorkspaces(root) {
  const workspaces = [];

  for (const group of ["apps", "packages"]) {
    const parent = path.join(root, group);

    if (!fs.existsSync(parent)) {
      continue;
    }

    for (const entry of fs.readdirSync(parent, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = path.join(parent, entry.name, "package.json");

      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      if (!manifest.name) {
        continue;
      }

      workspaces.push({
        name: manifest.name,
        path: normalize(path.relative(root, path.dirname(manifestPath))),
        scripts: manifest.scripts ?? {},
      });
    }
  }

  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}

function isDocumentationOnly(file) {
  return file.startsWith("docs/") || file === "README.md" || file.endsWith(".md");
}

function isGeneratedArtifact(file) {
  return (
    file.startsWith("artifacts/") ||
    file.startsWith("test-results/") ||
    file.startsWith("playwright-report/")
  );
}

function isGlobal(file) {
  if (GLOBAL_EXACT.has(file)) {
    return true;
  }

  if (GLOBAL_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true;
  }

  if (/^(?:eslint|prettier|vitest|vite)\..+/.test(file)) {
    return true;
  }

  if (/^tsconfig(?:\..+)?\.json$/.test(file)) {
    return true;
  }

  if (/^(?:docker-compose|compose\.).+\.(?:yml|yaml)$/.test(file)) {
    return true;
  }

  return false;
}

export function classifyChangedFiles(files, workspaces) {
  const direct = new Map();
  const ignored = [];
  const fullFallbackReasons = [];

  const sortedWorkspaces = [...workspaces].sort((a, b) => b.path.length - a.path.length);

  for (const original of files) {
    const file = normalize(original);

    if (!file) {
      continue;
    }

    if (isGeneratedArtifact(file) || isDocumentationOnly(file)) {
      ignored.push(file);
      continue;
    }

    const workspace = sortedWorkspaces.find(
      (candidate) => file === candidate.path || file.startsWith(`${candidate.path}/`),
    );

    if (workspace) {
      const paths = direct.get(workspace.name) ?? [];

      paths.push(file);

      direct.set(workspace.name, paths);

      continue;
    }

    if (isGlobal(file)) {
      fullFallbackReasons.push(`global:${file}`);

      continue;
    }

    fullFallbackReasons.push(`unknown:${file}`);
  }

  return {
    direct,
    ignored: [...new Set(ignored)].sort(),
    fullFallbackReasons: [...new Set(fullFallbackReasons)].sort(),
  };
}

function isRunnable(workspace) {
  return Boolean(workspace.scripts.test || workspace.scripts.typecheck);
}

export function buildAffectedPlan({ files, workspaces, full = false, resolveDependents }) {
  const classification = classifyChangedFiles(files, workspaces);

  const reasons = new Map();
  let fullFallback = full || classification.fullFallbackReasons.length > 0;

  const fullReasons = [...classification.fullFallbackReasons];

  if (full) {
    fullReasons.push("explicit:--full");
  }

  if (!fullFallback) {
    for (const [workspaceName, changedPaths] of classification.direct.entries()) {
      const existing = reasons.get(workspaceName) ?? [];

      existing.push(...changedPaths.map((file) => `changed:${file}`));

      reasons.set(workspaceName, existing);

      let dependents;

      try {
        dependents = resolveDependents(workspaceName);
      } catch (error) {
        fullFallback = true;
        fullReasons.push(
          `dependency-graph:${workspaceName}:${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }

      for (const dependent of dependents) {
        const dependentReasons = reasons.get(dependent) ?? [];

        if (dependent !== workspaceName) {
          dependentReasons.push(`depends-on:${workspaceName}`);
        }

        reasons.set(dependent, dependentReasons);
      }
    }
  }

  const selected = [];

  if (fullFallback) {
    for (const workspace of workspaces) {
      if (!isRunnable(workspace)) {
        continue;
      }

      selected.push({
        ...workspace,
        reasons: [...new Set(fullReasons)],
      });
    }
  } else {
    const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

    for (const [name, workspaceReasons] of reasons.entries()) {
      const workspace = byName.get(name);

      if (!workspace || !isRunnable(workspace)) {
        continue;
      }

      selected.push({
        ...workspace,
        reasons: [...new Set(workspaceReasons)],
      });
    }
  }

  selected.sort((a, b) => a.name.localeCompare(b.name));

  return {
    fullFallback,
    fullFallbackReasons: [...new Set(fullReasons)],
    directWorkspaces: [...classification.direct.keys()].sort(),
    ignoredFiles: classification.ignored,
    selected,
  };
}
