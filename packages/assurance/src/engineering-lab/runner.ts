import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, prettyJson, runCommand, runGit, sha256 } from "./internal.js";
import { EngineeringLabLedger, verifyEngineeringLabLedger } from "./ledger.js";
import {
  captureEngineeringLabSource,
  compareEngineeringLabSourceFingerprints,
  fingerprintEngineeringLabSource,
} from "./source-capture.js";
import type {
  EngineeringAgentAdapter,
  EngineeringAgentPlan,
  EngineeringLabAttemptResult,
  EngineeringLabCommandResult,
  EngineeringLabManifest,
  EngineeringLabManifestInput,
  EngineeringLabReport,
  EngineeringLabRunResult,
  EngineeringLabSourceProof,
  EngineeringLabTeardownResult,
  EngineeringLabVerificationResult,
} from "./types.js";
import {
  provisionEngineeringLabWorkspace,
  resetEngineeringLabCandidate,
  teardownEngineeringLabWorkspace,
  EngineeringLabProvisionError,
  type ProvisionedEngineeringLabWorkspace,
} from "./workspace.js";

export async function runEngineeringLabExperiment(
  input: EngineeringLabManifestInput & { adapter: EngineeringAgentAdapter },
): Promise<EngineeringLabRunResult> {
  validateInput(input);
  const startedAt = performance.now();
  const sourceRoot = await realpath(input.sourceRoot);
  const artifactRoot = await canonicalProspectivePath(input.artifactRoot);

  if (isWithin(sourceRoot, artifactRoot)) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_ARTIFACT_ROOT_INSIDE_SOURCE");
  }

  await createEmptyArtifactRoot(artifactRoot);

  const sourceCapture = await captureEngineeringLabSource(
    input.sourceRoot,
    artifactRoot,
    input.untrackedPolicy,
  );
  const manifest = freezeManifest({
    schemaVersion: 1,
    experimentId: input.experimentId,
    issueId: input.issueId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: {
      headSha: sourceCapture.headSha,
      treeSha: sourceCapture.treeSha,
      branch: sourceCapture.branch,
      trackedPatchRef: sourceCapture.trackedPatchRef,
      trackedPatchDigest: sourceCapture.trackedPatchDigest,
      trackedPatchBytes: sourceCapture.trackedPatchBytes,
      untrackedManifestRef: sourceCapture.untrackedManifestRef,
      untrackedBundleDigest: sourceCapture.untrackedBundleDigest,
      selectedUntrackedFiles: sourceCapture.selectedUntrackedFiles,
      excludedUntrackedFiles: sourceCapture.excludedUntrackedFiles,
    },
    invariants: [...input.invariants],
    verification: input.verification,
    runtimeRequirements: input.runtime,
    approvedAdapter: input.approvedAdapter,
    adapterCohorts: [...input.adapterCohorts],
    policies: {
      network: input.networkPolicy,
      externalSystems: input.externalSystemPolicy,
      productionCredentials: "forbidden",
      providerMutations: "forbidden",
      sourcePatchApplication: "forbidden",
    },
  });
  const manifestRef = "manifest.json";
  const ledgerRef = "ledger.jsonl";
  const ledgerVerificationRef = "ledger-verification.json";
  const reproductionRef = "reproduction.json";

  await writeImmutable(path.join(artifactRoot, manifestRef), prettyJson(manifest));

  const ledger = await EngineeringLabLedger.create(path.join(artifactRoot, ledgerRef));
  let workspace: ProvisionedEngineeringLabWorkspace | null = null;
  let adapterPlan: EngineeringAgentPlan | null = null;
  let attempts: EngineeringLabAttemptResult[] = [];
  let status: EngineeringLabReport["status"] = "lab_failed";
  let candidatePatchRef: string | null = null;
  let verificationRef: string | null = null;
  let changedFiles: readonly string[] = [];
  let teardown: EngineeringLabTeardownResult = {
    worktreeRemoved: false,
    runtimeRemoved: false,
    errors: ["provisioning_not_completed"],
  };

  try {
    workspace = await provisionEngineeringLabWorkspace({
      experimentId: input.experimentId,
      artifactRoot,
      sourceCapture,
      runtimeRequirements: input.runtime,
    });

    await writeImmutable(
      path.join(artifactRoot, "runtime-identity.json"),
      prettyJson(workspace.runtime),
    );
    await ledger.append({
      type: "provision",
      summary: "Provisioned detached source and isolated local runtime identities",
      evidenceRefs: [manifestRef, "runtime-identity.json"],
      facts: {
        baselineRevision: workspace.baselineRevision,
        runId: workspace.runtime.runId,
        composeProjectName: workspace.runtime.composeProjectName,
        databaseName: workspace.runtime.databaseName,
        queueNamespace: workspace.runtime.queueNamespace,
        ports: workspace.runtime.ports,
      },
    });

    const reproduction = await executeVerification(input.verification, "reproduction", workspace);

    await writeImmutable(path.join(artifactRoot, reproductionRef), prettyJson(reproduction));
    await ledger.append({
      type: "reproduction",
      summary: reproduction.matchedExpectation
        ? "Seeded defect reproduced before repair"
        : "Baseline did not match the declared reproduction oracle",
      evidenceRefs: [reproductionRef],
      command: input.verification.command,
      durationMs: reproduction.commandResult.durationMs,
      facts: {
        expectedExitCode: reproduction.expectedExitCode,
        actualExitCode: reproduction.commandResult.exitCode,
        matchedExpectation: reproduction.matchedExpectation,
      },
    });

    if (!reproduction.matchedExpectation) {
      status = "reproduction_failed";
    } else {
      adapterPlan = await input.adapter.propose({
        experimentId: input.experimentId,
        issueId: input.issueId,
        workspaceRoot: workspace.workspaceRoot,
        manifestPath: path.join(artifactRoot, manifestRef),
        invariants: input.invariants,
        verification: input.verification,
        reproductionArtifactRef: reproductionRef,
      });
      await ledger.append({
        type: "cost",
        summary: "Engineering-agent proposal cost and duration facts",
        durationMs: adapterPlan.durationMs,
        costUsd: adapterPlan.cost.amount,
        facts: {
          currency: adapterPlan.cost.currency,
          inputTokens: adapterPlan.cost.inputTokens ?? null,
          outputTokens: adapterPlan.cost.outputTokens ?? null,
        },
      });

      const evaluated = await evaluateAttempts({
        artifactRoot,
        workspace,
        plan: adapterPlan,
        verification: input.verification,
        ledger,
      });

      attempts = evaluated.attempts;
      candidatePatchRef = evaluated.candidatePatchRef;
      verificationRef = evaluated.verificationRef;
      changedFiles = evaluated.changedFiles;
      status = evaluated.proven ? "candidate_proven" : "candidate_failed";
    }
  } catch (error) {
    status = "lab_failed";

    if (error instanceof EngineeringLabProvisionError) {
      teardown = error.teardown;
    }

    await ledger.append({
      type: "observation",
      summary: "Engineering lab execution failed",
      facts: {
        error: errorMessage(error),
      },
    });
  } finally {
    if (workspace) {
      teardown = await teardownEngineeringLabWorkspace({
        isolatedRoot: workspace.isolatedRoot,
        workspaceRoot: workspace.workspaceRoot,
        sourceRoot: sourceCapture.sourceRoot,
      });
    }

    await writeImmutable(path.join(artifactRoot, "teardown.json"), prettyJson(teardown));
    await ledger.append({
      type: "teardown",
      summary:
        teardown.worktreeRemoved && teardown.runtimeRemoved
          ? "Detached worktree and isolated runtime were removed"
          : "Teardown completed with residual errors",
      evidenceRefs: ["teardown.json"],
      facts: {
        worktreeRemoved: teardown.worktreeRemoved,
        runtimeRemoved: teardown.runtimeRemoved,
        errors: teardown.errors,
      },
    });
  }

  const sourceAfter = await fingerprintEngineeringLabSource(
    sourceCapture.sourceRoot,
    sourceCapture.selectedUntrackedFiles.map(({ path: relativePath }) => relativePath),
  );
  const sourceMismatches = compareEngineeringLabSourceFingerprints(
    sourceCapture.sourceFingerprint,
    sourceAfter,
  );
  const sourceProof: EngineeringLabSourceProof = {
    unchanged: sourceMismatches.length === 0,
    before: sourceCapture.sourceFingerprint,
    after: sourceAfter,
    mismatches: sourceMismatches,
  };

  if (!sourceProof.unchanged || teardown.errors.length > 0) {
    status = "lab_failed";
  }

  await writeImmutable(
    path.join(artifactRoot, "source-worktree-proof.json"),
    prettyJson(sourceProof),
  );
  await ledger.append({
    type: "source_proof",
    summary: sourceProof.unchanged
      ? "Mechanical source fingerprint remained unchanged"
      : "Source fingerprint changed during experiment",
    evidenceRefs: ["source-worktree-proof.json"],
    facts: {
      unchanged: sourceProof.unchanged,
      mismatches: sourceProof.mismatches,
    },
  });

  const ledgerVerification = await verifyEngineeringLabLedger(path.join(artifactRoot, ledgerRef));

  if (!ledgerVerification.valid) {
    status = "lab_failed";
  }

  await writeImmutable(
    path.join(artifactRoot, ledgerVerificationRef),
    prettyJson({
      valid: ledgerVerification.valid,
      entryCount: ledgerVerification.entries.length,
      error: ledgerVerification.error ?? null,
    }),
  );
  await chmod(path.join(artifactRoot, ledgerRef), 0o444);

  const report: EngineeringLabReport = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    issueId: input.issueId,
    status,
    manifestRef,
    ledgerRef,
    ledgerVerificationRef,
    reproductionRef,
    attempts,
    candidatePatchRef,
    changedFiles,
    verificationRef,
    adapter: input.adapter.descriptor,
    adapterCohorts: input.adapterCohorts,
    cost: adapterPlan?.cost ?? null,
    durationMs: Math.round(performance.now() - startedAt),
    teardown,
    sourceProof,
    authorizationRequired: true,
    candidateAutoApplied: false,
  };

  await writeImmutable(path.join(artifactRoot, "report.json"), prettyJson(report));
  await writeImmutable(path.join(artifactRoot, "report.md"), renderReport(report));

  return {
    artifactRoot,
    manifest,
    report,
  };
}

async function evaluateAttempts(input: {
  artifactRoot: string;
  workspace: ProvisionedEngineeringLabWorkspace;
  plan: EngineeringAgentPlan;
  verification: EngineeringLabManifestInput["verification"];
  ledger: EngineeringLabLedger;
}): Promise<{
  attempts: EngineeringLabAttemptResult[];
  candidatePatchRef: string | null;
  verificationRef: string | null;
  changedFiles: readonly string[];
  proven: boolean;
}> {
  const attempts: EngineeringLabAttemptResult[] = [];
  const identifiers = input.plan.attempts.map(({ id }) => id);
  const artifactIdentifiers = identifiers.map(safeArtifactName);

  if (
    input.plan.attempts.length === 0 ||
    new Set(identifiers).size !== identifiers.length ||
    new Set(artifactIdentifiers).size !== artifactIdentifiers.length
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_AGENT_ATTEMPTS_INVALID");
  }

  for (let index = 0; index < input.plan.attempts.length; index += 1) {
    const attempt = input.plan.attempts[index];

    if (!attempt) {
      continue;
    }

    if (index > 0) {
      await resetEngineeringLabCandidate(input.workspace);
    }

    const safeId = safeArtifactName(attempt.id);
    const attemptRoot = `attempts/${String(index + 1).padStart(3, "0")}-${safeId}`;
    const proposalRef = `${attemptRoot}/proposal.patch`;
    const patchRef = `${attemptRoot}/candidate.patch`;
    const attemptVerificationRef = `${attemptRoot}/verification.json`;

    await writeImmutable(path.join(input.artifactRoot, proposalRef), attempt.patch);
    await input.ledger.append({
      type: "hypothesis",
      summary: attempt.hypothesis,
      evidenceRefs: [proposalRef],
      facts: { attemptId: attempt.id },
    });

    const application = await runGit(
      input.workspace.workspaceRoot,
      [
        "apply",
        "--index",
        "--binary",
        "--whitespace=error-all",
        path.join(input.artifactRoot, proposalRef),
      ],
      { allowFailure: true },
    );
    const candidatePatch = await runGit(
      input.workspace.workspaceRoot,
      ["diff", "--binary", "--full-index", input.workspace.baselineRevision, "--"],
      { maxCaptureBytes: 64 * 1024 * 1024 },
    );
    const changedFiles = await listChangedFiles(input.workspace);
    let verification: EngineeringLabVerificationResult;

    if (application.exitCode === 0) {
      verification = await executeVerification(input.verification, "candidate", input.workspace);
    } else {
      verification = {
        contractId: input.verification.id,
        phase: "candidate",
        expectedExitCode: input.verification.candidateExpectedExitCode,
        matchedExpectation: false,
        workspaceUnchangedDuringVerification: true,
        commandResult: failedApplicationResult(application),
      };
    }

    await writeImmutable(path.join(input.artifactRoot, patchRef), candidatePatch.stdout);
    await writeImmutable(
      path.join(input.artifactRoot, attemptVerificationRef),
      prettyJson(verification),
    );

    const proven =
      application.exitCode === 0 &&
      verification.matchedExpectation &&
      verification.workspaceUnchangedDuringVerification &&
      changedFiles.length > 0 &&
      !candidatePatch.stdoutTruncated;
    const result: EngineeringLabAttemptResult = {
      attemptId: attempt.id,
      hypothesis: attempt.hypothesis,
      status: proven ? "proven" : "failed",
      patchRef,
      verificationRef: attemptVerificationRef,
      changedFiles,
      verification,
    };

    attempts.push(result);
    await input.ledger.append({
      type: "candidate_patch",
      summary: proven
        ? "Candidate patch proved the verification contract"
        : "Candidate attempt failed",
      evidenceRefs: [proposalRef, patchRef, attemptVerificationRef],
      durationMs: verification.commandResult.durationMs,
      facts: {
        attemptId: attempt.id,
        patchApplied: application.exitCode === 0,
        changedFiles,
        verificationMatched: verification.matchedExpectation,
        workspaceUnchangedDuringVerification: verification.workspaceUnchangedDuringVerification,
      },
    });

    if (proven) {
      const candidatePatchRef = "candidate.patch";
      const verificationRef = "verification.json";

      await copyImmutable(
        path.join(input.artifactRoot, patchRef),
        path.join(input.artifactRoot, candidatePatchRef),
      );
      await copyImmutable(
        path.join(input.artifactRoot, attemptVerificationRef),
        path.join(input.artifactRoot, verificationRef),
      );
      await input.ledger.append({
        type: "verification",
        summary: "Final candidate satisfied the pinned verification contract",
        evidenceRefs: [candidatePatchRef, verificationRef],
        command: input.verification.command,
        durationMs: verification.commandResult.durationMs,
        facts: {
          changedFiles,
          actualExitCode: verification.commandResult.exitCode,
        },
      });

      return {
        attempts,
        candidatePatchRef,
        verificationRef,
        changedFiles,
        proven: true,
      };
    }
  }

  return {
    attempts,
    candidatePatchRef: null,
    verificationRef: null,
    changedFiles: [],
    proven: false,
  };
}

async function executeVerification(
  contract: EngineeringLabManifestInput["verification"],
  phase: EngineeringLabVerificationResult["phase"],
  workspace: ProvisionedEngineeringLabWorkspace,
): Promise<EngineeringLabVerificationResult> {
  const cwd = resolveCommandCwd(workspace.workspaceRoot, contract.command.relativeCwd);
  const statusBefore = await workspaceStatus(workspace.workspaceRoot);
  const commandResult = await runCommand(contract.command, cwd, workspace.runtime.environment);
  const statusAfter = await workspaceStatus(workspace.workspaceRoot);
  const expectedExitCode =
    phase === "reproduction"
      ? contract.reproductionExpectedExitCode
      : contract.candidateExpectedExitCode;

  return {
    contractId: contract.id,
    phase,
    expectedExitCode,
    matchedExpectation:
      !commandResult.timedOut &&
      commandResult.exitCode === expectedExitCode &&
      statusBefore === statusAfter,
    workspaceUnchangedDuringVerification: statusBefore === statusAfter,
    commandResult,
  };
}

async function workspaceStatus(workspaceRoot: string): Promise<string> {
  const result = await runGit(
    workspaceRoot,
    ["status", "--porcelain=v2", "--untracked-files=all", "-z"],
    { maxCaptureBytes: 16 * 1024 * 1024 },
  );

  if (result.stdoutTruncated) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_WORKSPACE_STATUS_TOO_LARGE");
  }

  return sha256(result.stdout);
}

async function listChangedFiles(
  workspace: ProvisionedEngineeringLabWorkspace,
): Promise<readonly string[]> {
  const result = await runGit(workspace.workspaceRoot, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "-z",
    workspace.baselineRevision,
    "--",
  ]);

  return result.stdout.split("\u0000").filter(Boolean).sort();
}

function failedApplicationResult(
  application: EngineeringLabCommandResult,
): EngineeringLabCommandResult {
  return {
    ...application,
    stderr: `candidate patch application failed\n${application.stderr}`,
  };
}

function resolveCommandCwd(workspaceRoot: string, relativeCwd?: string): string {
  const target = path.resolve(workspaceRoot, relativeCwd ?? ".");
  const relative = path.relative(workspaceRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_COMMAND_CWD_ESCAPE");
  }

  return target;
}

function validateInput(
  input: EngineeringLabManifestInput & { adapter: EngineeringAgentAdapter },
): void {
  if (
    !input.experimentId ||
    !input.issueId ||
    input.invariants.length === 0 ||
    input.networkPolicy !== "disabled" ||
    input.externalSystemPolicy !== "none" ||
    canonicalJson(input.approvedAdapter) !== canonicalJson(input.adapter.descriptor)
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_INPUT_INVALID");
  }

  if (input.createdAt !== undefined && !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_CREATED_AT_INVALID");
  }

  if (
    !Number.isInteger(input.verification.reproductionExpectedExitCode) ||
    !Number.isInteger(input.verification.candidateExpectedExitCode) ||
    input.verification.command.timeoutMs < 1
  ) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_VERIFICATION_CONTRACT_INVALID");
  }

  if (input.adapter.descriptor.kind !== "deterministic_fake") {
    throw new Error("ASSURANCE_ENGINEERING_LAB_CAPABLE_ADAPTER_NOT_SAFELY_AVAILABLE");
  }
}

async function createEmptyArtifactRoot(artifactRoot: string): Promise<void> {
  await mkdir(path.dirname(artifactRoot), { recursive: true });
  await mkdir(artifactRoot, { recursive: false, mode: 0o700 });

  if ((await readdir(artifactRoot)).length !== 0) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_ARTIFACT_ROOT_NOT_EMPTY");
  }
}

async function writeImmutable(target: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { flag: "wx", mode: 0o444 });
  await chmod(target, 0o444);
}

async function copyImmutable(source: string, target: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o444);
}

function safeArtifactName(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!value) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_ATTEMPT_ID_INVALID");
  }

  return value.slice(0, 80);
}

function freezeManifest(manifest: EngineeringLabManifest): EngineeringLabManifest {
  return deepFreeze(manifest);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

function renderReport(report: EngineeringLabReport): string {
  const attempts = report.attempts
    .map(
      (attempt) =>
        `- ${attempt.attemptId}: ${attempt.status}; patch \`${attempt.patchRef}\`; verification \`${attempt.verificationRef}\``,
    )
    .join("\n");
  const unavailable = report.adapterCohorts
    .filter(({ status }) => status === "unavailable")
    .map(({ cohort, reason }) => `- ${cohort}: unavailable — ${reason ?? "unspecified"}`)
    .join("\n");

  return `# Engineering experiment ${report.experimentId}

- Status: ${report.status}
- Issue: ${report.issueId}
- Source unchanged: ${report.sourceProof.unchanged}
- Candidate auto-applied: ${report.candidateAutoApplied}
- Human authorization required: ${report.authorizationRequired}
- Duration: ${report.durationMs} ms
- Cost: ${report.cost ? `${report.cost.amount} ${report.cost.currency}` : "not incurred"}

## Attempts

${attempts || "- No candidate attempts ran."}

## Candidate

- Patch: ${report.candidatePatchRef ?? "none"}
- Verification: ${report.verificationRef ?? "none"}
- Changed files: ${report.changedFiles.join(", ") || "none"}

## Teardown

- Worktree removed: ${report.teardown.worktreeRemoved}
- Runtime removed: ${report.teardown.runtimeRemoved}
- Errors: ${report.teardown.errors.join("; ") || "none"}

## Unavailable cohorts

${unavailable || "- None."}
`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
