import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createDeterministicEngineeringAgentAdapter,
  fingerprintEngineeringLabSource,
  runEngineeringLabExperiment,
  verifyEngineeringLabLedger,
} from "../src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Assurance engineering lab", () => {
  it("reproduces, iterates truthfully, proves a candidate, and leaves source unchanged", async () => {
    const repositoryRoot = await createSeededRepository();
    const artifactParent = await makeTemporaryRoot("scry-assurance-artifacts-");
    const artifactRoot = path.join(artifactParent, "experiment");
    const before = await fingerprintEngineeringLabSource(repositoryRoot);
    const adapter = createDeterministicEngineeringAgentAdapter({
      id: "deterministic-repair",
      attempts: [
        {
          id: "failed-magnitude",
          hypothesis: "Use addition, initially with the wrong magnitude.",
          patch: counterPatch(2),
        },
        {
          id: "minimal-repair",
          hypothesis: "Restore the exact increment invariant.",
          patch: counterPatch(1),
        },
      ],
    });
    const result = await runEngineeringLabExperiment({
      experimentId: "seeded-increment",
      issueId: "seeded-off-by-one",
      sourceRoot: repositoryRoot,
      artifactRoot,
      invariants: ["Candidate changes never leave the isolated worktree."],
      verification: {
        id: "increment-regression",
        claim: "increment advances by one",
        command: {
          executable: process.execPath,
          args: ["--test", "counter.test.mjs"],
          relativeCwd: "fixture",
          timeoutMs: 10_000,
        },
        reproductionExpectedExitCode: 1,
        candidateExpectedExitCode: 0,
      },
      runtime: {
        database: "isolated_local_directory",
        queue: "isolated_local_namespace",
        browser: "isolated_local_profile",
        fixtures: ["fixture/counter.mjs"],
        portCount: 2,
      },
      untrackedPolicy: {
        allowedPathPrefixes: ["fixtures"],
        maxFileBytes: 1_024,
        maxTotalBytes: 2_048,
      },
      approvedAdapter: adapter.descriptor,
      adapter,
      adapterCohorts: [
        { cohort: "deterministic-fake", status: "available" },
        {
          cohort: "capable-agent",
          status: "unavailable",
          reason: "No proven local-only agent sandbox in this test.",
        },
      ],
      networkPolicy: "disabled",
      externalSystemPolicy: "none",
      createdAt: "2026-08-23T00:00:00.000Z",
    });

    expect(
      result.report.status,
      `${JSON.stringify(result.report, null, 2)}\n${await readFile(path.join(artifactRoot, "ledger.jsonl"), "utf8")}`,
    ).toBe("candidate_proven");
    expect(result.report.attempts.map(({ status }) => status)).toEqual(["failed", "proven"]);
    expect(result.report.changedFiles).toEqual(["fixture/counter.mjs"]);
    expect(result.report.candidateAutoApplied).toBe(false);
    expect(result.report.authorizationRequired).toBe(true);
    expect(result.report.sourceProof.unchanged).toBe(true);
    expect(result.report.teardown).toMatchObject({
      worktreeRemoved: true,
      runtimeRemoved: true,
      errors: [],
    });
    expect(result.report.cost).toEqual({
      currency: "USD",
      amount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(await readFile(path.join(repositoryRoot, "fixture/counter.mjs"), "utf8")).toContain(
      "value - 1",
    );
    expect(await fingerprintEngineeringLabSource(repositoryRoot)).toEqual(before);

    const manifest = JSON.parse(
      await readFile(path.join(artifactRoot, "manifest.json"), "utf8"),
    ) as {
      source: {
        selectedUntrackedFiles: Array<{ path: string }>;
        excludedUntrackedFiles: Array<{ path: string; reason: string }>;
      };
    };

    expect(manifest.source.selectedUntrackedFiles.map(({ path: file }) => file)).toEqual([
      "fixtures/context.txt",
    ]);
    expect(manifest.source.excludedUntrackedFiles).toEqual(
      expect.arrayContaining([
        { path: ".env.local", reason: "secret_or_credential" },
        { path: "artifacts/generated.txt", reason: "generated_or_artifact" },
        { path: "notes.txt", reason: "not_explicitly_allowed" },
      ]),
    );
    expect((await stat(path.join(artifactRoot, "manifest.json"))).mode & 0o777).toBe(0o444);

    const candidatePatch = await readFile(path.join(artifactRoot, "candidate.patch"), "utf8");
    expect(candidatePatch).toContain("+  return value + 1;");
    expect(
      await readFile(
        path.join(artifactRoot, "attempts/001-failed-magnitude/candidate.patch"),
        "utf8",
      ),
    ).toContain("+  return value + 2;");

    const ledger = await verifyEngineeringLabLedger(path.join(artifactRoot, "ledger.jsonl"));
    expect(ledger.valid).toBe(true);
    expect(ledger.entries.some(({ type }) => type === "reproduction")).toBe(true);
    expect(ledger.entries.at(-1)?.type).toBe("source_proof");
    expect((await stat(path.join(artifactRoot, "ledger.jsonl"))).mode & 0o777).toBe(0o444);
  }, 30_000);

  it("detects a rewritten investigation ledger entry", async () => {
    const repositoryRoot = await createSeededRepository();
    const artifactParent = await makeTemporaryRoot("scry-assurance-ledger-");
    const artifactRoot = path.join(artifactParent, "experiment");
    const adapter = createDeterministicEngineeringAgentAdapter({
      id: "one-repair",
      attempts: [{ id: "repair", hypothesis: "repair", patch: counterPatch(1) }],
    });

    await runEngineeringLabExperiment({
      experimentId: "ledger-tamper",
      issueId: "seeded",
      sourceRoot: repositoryRoot,
      artifactRoot,
      invariants: ["Ledger is hash linked."],
      verification: {
        id: "increment",
        claim: "increment",
        command: {
          executable: process.execPath,
          args: ["--test", "counter.test.mjs"],
          relativeCwd: "fixture",
          timeoutMs: 10_000,
        },
        reproductionExpectedExitCode: 1,
        candidateExpectedExitCode: 0,
      },
      runtime: {
        database: "isolated_local_directory",
        queue: "isolated_local_namespace",
        browser: "isolated_local_profile",
        fixtures: ["fixture/counter.mjs"],
        portCount: 0,
      },
      untrackedPolicy: {
        allowedPathPrefixes: ["fixtures"],
        maxFileBytes: 1_024,
        maxTotalBytes: 2_048,
      },
      approvedAdapter: adapter.descriptor,
      adapter,
      adapterCohorts: [{ cohort: "deterministic-fake", status: "available" }],
      networkPolicy: "disabled",
      externalSystemPolicy: "none",
    });

    const ledgerPath = path.join(artifactRoot, "ledger.jsonl");
    const original = await readFile(ledgerPath, "utf8");
    await chmod(ledgerPath, 0o600);
    await writeFile(ledgerPath, original.replace("Provisioned", "Rewritten"));

    await expect(verifyEngineeringLabLedger(ledgerPath)).resolves.toMatchObject({
      valid: false,
      error: "hash:1",
    });
  }, 30_000);

  it("refuses an artifact root inside the source worktree before writing", async () => {
    const repositoryRoot = await createSeededRepository();
    const before = await fingerprintEngineeringLabSource(repositoryRoot);
    const artifactRoot = path.join(repositoryRoot, "experiment-output");
    const adapter = createDeterministicEngineeringAgentAdapter({
      id: "refused",
      attempts: [{ id: "repair", hypothesis: "repair", patch: counterPatch(1) }],
    });

    await expect(
      runEngineeringLabExperiment({
        experimentId: "refused-output",
        issueId: "seeded",
        sourceRoot: repositoryRoot,
        artifactRoot,
        invariants: ["Source remains unchanged."],
        verification: {
          id: "increment",
          claim: "increment",
          command: {
            executable: process.execPath,
            args: ["--test", "counter.test.mjs"],
            relativeCwd: "fixture",
            timeoutMs: 10_000,
          },
          reproductionExpectedExitCode: 1,
          candidateExpectedExitCode: 0,
        },
        runtime: {
          database: "isolated_local_directory",
          queue: "isolated_local_namespace",
          browser: "isolated_local_profile",
          fixtures: ["fixture/counter.mjs"],
          portCount: 0,
        },
        untrackedPolicy: {
          allowedPathPrefixes: ["fixtures"],
          maxFileBytes: 1_024,
          maxTotalBytes: 2_048,
        },
        approvedAdapter: adapter.descriptor,
        adapter,
        adapterCohorts: [{ cohort: "deterministic-fake", status: "available" }],
        networkPolicy: "disabled",
        externalSystemPolicy: "none",
      }),
    ).rejects.toThrow("ASSURANCE_ENGINEERING_LAB_ARTIFACT_ROOT_INSIDE_SOURCE");
    await expect(access(artifactRoot)).rejects.toThrow();
    expect(await fingerprintEngineeringLabSource(repositoryRoot)).toEqual(before);
  });
});

async function createSeededRepository(): Promise<string> {
  const root = await makeTemporaryRoot("scry-assurance-source-");

  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "tracked-context.txt"), "initial\n");
  await writeFileAt(
    root,
    "fixture/counter.mjs",
    "export function increment(value) {\n  return value - 1;\n}\n",
  );
  await writeFileAt(
    root,
    "fixture/counter.test.mjs",
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { increment } from "./counter.mjs";\ntest("increment", () => assert.equal(increment(4), 5));\n',
  );
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Assurance Test"]);
  git(root, ["config", "user.email", "assurance-test@example.invalid"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);

  await writeFile(path.join(root, "tracked-context.txt"), "dirty but preserved\n");
  await writeFileAt(root, "fixtures/context.txt", "selected context\n");
  await writeFile(path.join(root, ".env.local"), "DO_NOT_CAPTURE=value\n");
  await writeFileAt(root, "artifacts/generated.txt", "generated\n");
  await writeFile(path.join(root, "notes.txt"), "unrelated\n");

  return root;
}

async function writeFileAt(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function counterPatch(amount: number): string {
  return `diff --git a/fixture/counter.mjs b/fixture/counter.mjs
--- a/fixture/counter.mjs
+++ b/fixture/counter.mjs
@@ -1,3 +1,3 @@
 export function increment(value) {
-  return value - 1;
+  return value + ${amount};
 }
`;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "pipe",
  });
}

async function makeTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
