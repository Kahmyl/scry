import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAuthoritativeSourceIdentity,
  assertRuntimeSourceIdentity,
  deriveRepositorySourceIdentity,
  sourceIdentityEnvironment,
} from "../../../scripts/source-identity.mjs";

const temporaryRepositories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("M6 Q5 authoritative source identity", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRepositories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it("derives the actual clean commit and canonical manifest", async () => {
    const repository = await cleanRepository();
    const identity = deriveRepositorySourceIdentity(repository.root);

    expect(identity).toEqual({
      commitSha: repository.commitSha,
      dirty: false,
      manifestSha256: createHash("sha256").update(repository.commitSha).update("\0").digest("hex"),
    });
    expect(() => assertAuthoritativeSourceIdentity(identity, identity)).not.toThrow();
    expect(sourceIdentityEnvironment(identity)).toEqual({
      SCRY_GIT_COMMIT: repository.commitSha,
      SCRY_SOURCE_DIRTY: "false",
      SCRY_SOURCE_MANIFEST_SHA256: identity.manifestSha256,
    });
  });

  it("never represents dirty source as clean", async () => {
    const repository = await cleanRepository();
    await writeFile(path.join(repository.root, "source.txt"), "dirty\n", "utf8");
    const identity = deriveRepositorySourceIdentity(repository.root);

    expect(identity.dirty).toBe(true);
    expect(sourceIdentityEnvironment(identity).SCRY_SOURCE_DIRTY).toBe("true");
    expect(() => assertAuthoritativeSourceIdentity(identity, identity)).toThrow(
      "AUTHORITATIVE_SOURCE_IDENTITY_DIRTY",
    );
  });

  it("fails closed for an expected commit from a different source", async () => {
    const repository = await cleanRepository();
    const identity = deriveRepositorySourceIdentity(repository.root);

    expect(() =>
      assertAuthoritativeSourceIdentity(identity, {
        ...identity,
        commitSha: "a".repeat(40),
      }),
    ).toThrow("AUTHORITATIVE_SOURCE_IDENTITY_COMMIT_MISMATCH");
  });

  it("fails closed for a stale or mismatched manifest", async () => {
    const repository = await cleanRepository();
    const identity = deriveRepositorySourceIdentity(repository.root);

    expect(() =>
      assertAuthoritativeSourceIdentity(identity, {
        ...identity,
        manifestSha256: "b".repeat(64),
      }),
    ).toThrow("AUTHORITATIVE_SOURCE_IDENTITY_MANIFEST_MISMATCH");
  });

  it("rejects runtime identity that diverges from the verified source", async () => {
    const repository = await cleanRepository();
    const identity = deriveRepositorySourceIdentity(repository.root);

    expect(() =>
      assertRuntimeSourceIdentity(
        {
          gitCommit: identity.commitSha,
          dirty: true,
          manifestSha256: identity.manifestSha256,
        },
        identity,
      ),
    ).toThrow("AUTHORITATIVE_RUNTIME_SOURCE_IDENTITY_MISMATCH");
  });

  it("keeps synthetic fixture identity out of the authoritative launcher", async () => {
    const launcher = await readFile(
      path.join(repositoryRoot, "apps/api/scripts/m6-q5-authoritative.ts"),
      "utf8",
    );
    const syntheticFixture = await readFile(
      path.join(repositoryRoot, "apps/api/test/m6-mcp-campaign.integration.test.ts"),
      "utf8",
    );
    const dockerLauncher = await readFile(
      path.join(repositoryRoot, "scripts/docker-up.mjs"),
      "utf8",
    );

    expect(launcher).not.toContain('"e".repeat(64)');
    expect(launcher).not.toContain('SCRY_SOURCE_DIRTY: "true"');
    expect(launcher).not.toContain("5da3201636bac6b69c0943845bc1d05852d6f6c0");
    expect(launcher).not.toContain("6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1");
    expect(launcher).not.toContain("9a581bb0-2276-4888-9ddb-07b2485cddc3");
    expect(launcher).not.toContain("64d30899-8278-4a42-89b9-c34dce6b000f");
    expect(launcher).toContain("deriveRepositorySourceIdentity(root)");
    expect(launcher).toContain("assertAuthoritativeSourceIdentity(initialSource");
    expect(launcher).toContain("assertRuntimeSourceIdentity(api.sourceIdentity, initialSource)");
    expect(dockerLauncher).toContain("deriveRepositorySourceIdentity()");
    expect(dockerLauncher).toContain("sourceIdentityEnvironment(sourceIdentity)");
    expect(syntheticFixture).toContain('SCRY_SOURCE_MANIFEST_SHA256: "e".repeat(64)');
    expect(syntheticFixture).toContain('SCRY_SOURCE_DIRTY: "true"');
  });

  it("completes every source and runtime gate before transactionally preparing authority", async () => {
    const launcher = await readFile(
      path.join(repositoryRoot, "apps/api/scripts/m6-q5-authoritative.ts"),
      "utf8",
    );
    const paidBoundary = launcher.indexOf("await crossPaidQ5Boundary({");
    const gateBinding = launcher.indexOf("gates,", paidBoundary);
    const authorityPreparation = launcher.indexOf(
      "prepared = await provisionExactQualificationScope(preparedScope, protectedContext)",
    );
    const canonicalBootstrap = launcher.indexOf(
      "const bootstrap = await prepareCanonicalQ5Scope()",
    );
    const gates = launcher.indexOf("const gates = await gatesForCurrentRuntime");
    const transactionalPreparation = launcher.indexOf(
      "const attempt = await attempts.prepareUsing",
    );
    const finalRuntimeRefingerprint = launcher.indexOf(
      "await assertCampaignSourceStable()",
      transactionalPreparation,
    );
    const attemptConsumption = launcher.indexOf(
      "await attempts.consumeUsing(",
      transactionalPreparation,
    );
    const paidAgent = launcher.indexOf("return Q5OwnedProcess.start({");

    expect(paidBoundary).toBeGreaterThan(-1);
    expect(canonicalBootstrap).toBeGreaterThan(-1);
    expect(gates).toBeGreaterThan(canonicalBootstrap);
    expect(paidBoundary).toBeGreaterThan(gates);
    expect(gateBinding).toBeGreaterThan(paidBoundary);
    expect(authorityPreparation).toBeGreaterThan(gateBinding);
    expect(paidAgent).toBeGreaterThan(authorityPreparation);
    expect(transactionalPreparation).toBeGreaterThan(-1);
    expect(finalRuntimeRefingerprint).toBeGreaterThan(transactionalPreparation);
    expect(attemptConsumption).toBeGreaterThan(finalRuntimeRefingerprint);
  });
});

async function cleanRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "scry-q5-source-"));
  temporaryRepositories.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "q5@example.test"]);
  git(root, ["config", "user.name", "Q5 Source Test"]);
  await writeFile(path.join(root, "source.txt"), "clean\n", "utf8");
  git(root, ["add", "source.txt"]);
  git(root, ["commit", "--quiet", "-m", "source"]);
  return { root, commitSha: git(root, ["rev-parse", "HEAD"]).trim() };
}

function git(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
