import { randomInt, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGit } from "./internal.js";
import type {
  EngineeringLabRuntimeIdentity,
  EngineeringLabRuntimeRequirements,
  EngineeringLabSourceCapture,
  EngineeringLabTeardownResult,
} from "./types.js";

const ISOLATION_MARKER = ".scry-assurance-engineering-lab";

export interface ProvisionedEngineeringLabWorkspace {
  isolatedRoot: string;
  workspaceRoot: string;
  baselineRevision: string;
  runtime: EngineeringLabRuntimeIdentity;
}

export class EngineeringLabProvisionError extends Error {
  readonly teardown: EngineeringLabTeardownResult;

  constructor(cause: unknown, teardown: EngineeringLabTeardownResult) {
    super(`ASSURANCE_ENGINEERING_LAB_PROVISION_FAILED:${errorMessage(cause)}`);
    this.name = "EngineeringLabProvisionError";
    this.teardown = teardown;
  }
}

export async function provisionEngineeringLabWorkspace(input: {
  experimentId: string;
  artifactRoot: string;
  sourceCapture: EngineeringLabSourceCapture;
  runtimeRequirements: EngineeringLabRuntimeRequirements;
}): Promise<ProvisionedEngineeringLabWorkspace> {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "scry-assurance-engineering-lab-"));
  const markerPath = path.join(isolatedRoot, ISOLATION_MARKER);
  const workspaceRoot = path.join(isolatedRoot, "source");

  await writeFile(markerPath, `${input.experimentId}\n`, { flag: "wx", mode: 0o600 });

  try {
    await runGit(input.sourceCapture.sourceRoot, [
      "worktree",
      "add",
      "--detach",
      workspaceRoot,
      input.sourceCapture.headSha,
    ]);

    if (input.sourceCapture.trackedPatchBytes > 0) {
      await runGit(workspaceRoot, [
        "apply",
        "--index",
        "--binary",
        path.join(input.artifactRoot, input.sourceCapture.trackedPatchRef),
      ]);
    }

    for (const file of input.sourceCapture.selectedUntrackedFiles) {
      const target = safeWorkspacePath(workspaceRoot, file.path);

      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(input.artifactRoot, file.blobRef), target);
      await chmod(target, file.executable ? 0o755 : 0o644);
    }

    const baselineRevision = await anchorCapturedBaseline(workspaceRoot);
    const runtime = await provisionRuntimeIdentity(
      isolatedRoot,
      input.artifactRoot,
      input.experimentId,
      input.runtimeRequirements,
    );

    return {
      isolatedRoot,
      workspaceRoot,
      baselineRevision,
      runtime,
    };
  } catch (error) {
    const teardown = await teardownEngineeringLabWorkspace({
      isolatedRoot,
      workspaceRoot,
      sourceRoot: input.sourceCapture.sourceRoot,
    });
    throw new EngineeringLabProvisionError(error, teardown);
  }
}

export async function resetEngineeringLabCandidate(
  workspace: ProvisionedEngineeringLabWorkspace,
): Promise<void> {
  await assertIsolatedWorkspace(workspace.isolatedRoot, workspace.workspaceRoot);
  await runGit(workspace.workspaceRoot, ["reset", "--hard", workspace.baselineRevision]);
  await runGit(workspace.workspaceRoot, ["clean", "-ffdx"]);
}

export async function teardownEngineeringLabWorkspace(input: {
  isolatedRoot: string;
  workspaceRoot: string;
  sourceRoot: string;
}): Promise<EngineeringLabTeardownResult> {
  const errors: string[] = [];
  let worktreeRemoved = false;
  let runtimeRemoved = false;

  try {
    await assertIsolatedWorkspace(input.isolatedRoot, input.workspaceRoot);
  } catch (error) {
    return {
      worktreeRemoved,
      runtimeRemoved,
      errors: [errorMessage(error)],
    };
  }

  try {
    const result = await runGit(
      input.sourceRoot,
      ["worktree", "remove", "--force", input.workspaceRoot],
      { allowFailure: true },
    );

    if (result.exitCode === 0) {
      worktreeRemoved = true;
    } else {
      errors.push(`worktree:${result.stderr.trim()}`);
    }
  } catch (error) {
    errors.push(`worktree:${errorMessage(error)}`);
  }

  try {
    await rm(input.isolatedRoot, { recursive: true, force: true });
    runtimeRemoved = true;
  } catch (error) {
    errors.push(`runtime:${errorMessage(error)}`);
  }

  return {
    worktreeRemoved,
    runtimeRemoved,
    errors,
  };
}

async function anchorCapturedBaseline(workspaceRoot: string): Promise<string> {
  const status = await runGit(workspaceRoot, ["status", "--porcelain=v1", "-z"]);

  if (status.stdout.length > 0) {
    await runGit(workspaceRoot, ["add", "-A"]);
    await runGit(workspaceRoot, [
      "-c",
      "user.name=Scry Assurance",
      "-c",
      "user.email=assurance.invalid@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "assurance: anchor captured experiment source",
    ]);
  }

  return (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

async function provisionRuntimeIdentity(
  isolatedRoot: string,
  artifactRoot: string,
  experimentId: string,
  requirements: EngineeringLabRuntimeRequirements,
): Promise<EngineeringLabRuntimeIdentity> {
  if (
    !Number.isInteger(requirements.portCount) ||
    requirements.portCount < 0 ||
    requirements.portCount > 16
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_PORT_COUNT_INVALID");
  }

  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const safeExperimentId = experimentId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32);
  const runId = `${safeExperimentId}-${nonce}`;
  const runtimeRoot = path.join(isolatedRoot, "runtime");
  const databaseDirectory = path.join(runtimeRoot, "database");
  const queueDirectory = path.join(runtimeRoot, "queue");
  const browserProfileDirectory = path.join(runtimeRoot, "browser-profile");
  const fixtureDirectory = path.join(runtimeRoot, "fixtures");

  await Promise.all(
    [databaseDirectory, queueDirectory, browserProfileDirectory, fixtureDirectory].map(
      async (directory) => await mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );

  const ports: number[] = [];

  for (let index = 0; index < requirements.portCount; index += 1) {
    let port: number;

    do {
      port = randomInt(20_000, 60_000);
    } while (ports.includes(port));

    ports.push(port);
  }

  return {
    runId,
    composeProjectName: `scry-assurance-${runId}`.slice(0, 63),
    databaseDirectory,
    databaseName: `scry_assurance_${nonce}`,
    queueDirectory,
    queueNamespace: `scry:assurance:${nonce}`,
    browserProfileDirectory,
    fixtureDirectory,
    artifactDirectory: artifactRoot,
    ports,
    environment: {
      SCRY_ASSURANCE_RUN_ID: runId,
      SCRY_ASSURANCE_DATABASE_DIRECTORY: databaseDirectory,
      SCRY_ASSURANCE_DATABASE_NAME: `scry_assurance_${nonce}`,
      SCRY_ASSURANCE_QUEUE_DIRECTORY: queueDirectory,
      SCRY_ASSURANCE_QUEUE_NAMESPACE: `scry:assurance:${nonce}`,
      SCRY_ASSURANCE_BROWSER_PROFILE: browserProfileDirectory,
      SCRY_ASSURANCE_FIXTURE_DIRECTORY: fixtureDirectory,
      SCRY_ASSURANCE_ARTIFACT_DIRECTORY: artifactRoot,
    },
  };
}

async function assertIsolatedWorkspace(isolatedRoot: string, workspaceRoot: string): Promise<void> {
  const expectedPrefix = path.join(tmpdir(), "scry-assurance-engineering-lab-");

  if (
    !path.resolve(isolatedRoot).startsWith(expectedPrefix) ||
    path.resolve(workspaceRoot) !== path.join(path.resolve(isolatedRoot), "source")
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_TEARDOWN_TARGET_REFUSED");
  }

  await access(path.join(isolatedRoot, ISOLATION_MARKER));
}

function safeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const target = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, target);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_UNTRACKED_PATH_ESCAPE");
  }

  return target;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
