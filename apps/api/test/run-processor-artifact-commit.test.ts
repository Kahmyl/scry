import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalArtifactStore, signVeilEvidenceAdmission } from "@scry/artifact";
import { compileDefaultVeilPolicy } from "@scry/veil";
import { describe, expect, it, vi } from "vitest";

import { createRunProcessor } from "../src/workers/index.js";

const admissionKey = "artifact-commit-test-key-at-least-32-bytes";
const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const sanitation = {
  stage: "post_capture",
  method: "SecretRedactor.redact",
  attestedAt: "2026-08-08T00:00:00.000Z",
};

describe("Run processor recoverable artifact commit", () => {
  it("deletes every uploaded byte when artifact manifest persistence fails", async () => {
    const fixture = await createFixture();
    const manifestFailure = new Error("MANIFEST_PERSISTENCE_FAILED");
    fixture.executions.recordArtifact.mockImplementation(async () => {
      if (fixture.executions.recordArtifact.mock.calls.length === 2) throw manifestFailure;
    });

    await expect(fixture.processor(fixture.job as never)).rejects.toBe(manifestFailure);

    expect(fixture.executions.recordArtifact).toHaveBeenCalledTimes(2);
    expect(fixture.executions.recordArtifactTimeline).not.toHaveBeenCalled();
    await expectNoReadableArtifacts(fixture);
    expect(fixture.executions.completeAttempt).not.toHaveBeenCalled();
    expect(fixture.executions.failAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      expect.any(String),
      "MANIFEST_PERSISTENCE_FAILED",
      false,
    );
  });

  it("deletes every uploaded byte when artifact timeline persistence fails", async () => {
    const fixture = await createFixture();
    const timelineFailure = new Error("TIMELINE_PERSISTENCE_FAILED");
    fixture.executions.recordArtifactTimeline.mockRejectedValue(timelineFailure);

    await expect(fixture.processor(fixture.job as never)).rejects.toBe(timelineFailure);

    expect(fixture.executions.recordArtifact).toHaveBeenCalledTimes(2);
    expect(fixture.executions.recordArtifactTimeline).toHaveBeenCalledOnce();
    await expectNoReadableArtifacts(fixture);
    expect(fixture.executions.completeAttempt).not.toHaveBeenCalled();
    expect(fixture.executions.failAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      expect.any(String),
      "TIMELINE_PERSISTENCE_FAILED",
      false,
    );
  });

  it("reports an explicit unsafe commit failure when compensation cannot prove deletion", async () => {
    const fixture = await createFixture();
    fixture.executions.recordArtifactTimeline.mockRejectedValue(
      new Error("TIMELINE_PERSISTENCE_FAILED"),
    );
    vi.spyOn(fixture.store, "delete").mockRejectedValue(new Error("STORAGE_DELETE_FAILED"));

    await expect(fixture.processor(fixture.job as never)).rejects.toThrow(
      "ARTIFACT_COMMIT_COMPENSATION_FAILED",
    );

    expect(fixture.executions.failAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      expect.any(String),
      "ARTIFACT_COMMIT_COMPENSATION_FAILED",
      false,
    );
  });
});

async function createFixture() {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "scry-run-staging-"));
  const storeRoot = await mkdtemp(path.join(tmpdir(), "scry-run-store-"));
  const outputDirectory = path.join(artifactRoot, runId, "attempt-1");
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = [
    admittedArtifact("33333333-3333-4333-8333-333333333331", "first.txt", "first"),
    admittedArtifact("33333333-3333-4333-8333-333333333332", "second.txt", "second"),
  ];
  for (const fixture of artifacts)
    await writeFile(path.join(outputDirectory, fixture.artifact.relativePath), fixture.content);

  const executions = {
    claimAttempt: vi.fn(async () => ({ id: attemptId, attemptNumber: 1 })),
    loadExecution: vi.fn(async () => ({
      flowRevisionId: "flow-revision",
      environmentId: "environment",
      planSnapshot: readOnlyPlan(),
      policySnapshot: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false },
      veilPolicySnapshot: compileDefaultVeilPolicy({
        allowedOrigins: ["https://example.test"],
        allowDownloads: false,
      }),
      executionSnapshot: { viewport: { width: 1280, height: 720 } },
    })),
    markRunning: vi.fn(async () => undefined),
    setRunPhase: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => true),
    isCancellationRequested: vi.fn(async () => false),
    markFinalizing: vi.fn(async () => undefined),
    recordStepResult: vi.fn(async () => undefined),
    recordAssertion: vi.fn(async () => undefined),
    recordCaptureEpochs: vi.fn(async () => undefined),
    recordArtifact: vi.fn(async () => undefined),
    recordArtifactTimeline: vi.fn(async () => undefined),
    completeAttempt: vi.fn(async () => undefined),
    failAttempt: vi.fn(async () => undefined),
    appendEvent: vi.fn(async () => undefined),
  };
  const report = {
    runId,
    attemptId,
    state: "passed" as const,
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:00:01.000Z",
    durationMs: 1_000,
    requiredAssertions: { passed: 0, failed: 0, unevaluated: 0 },
    artifacts: artifacts.map(({ artifact }) => artifact),
    planName: "Artifact commit",
    outcomeClassification: "passed" as const,
    steps: [],
    diagnostics: [],
    policyViolations: [],
    artifactTimeline: [],
  };
  const store = new LocalArtifactStore(storeRoot, admissionKey);
  const capabilities = {
    createRun: vi.fn(() => ({ manifest: { digest: "a".repeat(64) }, options: {} })),
    request: vi.fn(() => ({ operationId: `attempt-${attemptId}` })),
  };
  const processor = createRunProcessor({
    executions: executions as never,
    workerId: "worker-1",
    releaseId: "release-1",
    schemaFingerprint: "schema-1",
    heartbeatMs: 60_000,
    artifactRoot,
    artifactRetentionMs: 60_000,
    artifactStore: store,
    artifactStoreRemote: false,
    veilAdmissionKey: admissionKey,
    browserChannel: "chromium",
    kernel: { execute: vi.fn(async () => ({ report })) } as never,
    capabilities: capabilities as never,
  });
  return {
    artifacts,
    executions,
    processor,
    store,
    job: {
      data: { runId, releaseId: "release-1", schemaFingerprint: "schema-1" },
      attemptsMade: 0,
      opts: { attempts: 1 },
    },
  };
}

function admittedArtifact(id: string, relativePath: string, value: string) {
  const content = new TextEncoder().encode(value);
  const manifest = {
    schemaVersion: 1 as const,
    evidenceId: id,
    channel: "dom" as const,
    classification: "public" as const,
    disposition: "sanitize" as const,
    policyDigest: "a".repeat(64),
    decisionId: `decision-${id}`,
    contentDigest: createHash("sha256").update(content).digest("hex"),
    omissionIntervals: [],
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  const proof = signVeilEvidenceAdmission(manifest, admissionKey, sanitation);
  return {
    content,
    proof,
    storageKey: path.join(runId, "attempt-1", relativePath),
    artifact: {
      id,
      kind: "dom" as const,
      availability: "available" as const,
      privacyClassification: "sanitized" as const,
      contentType: "text/plain",
      relativePath,
      observation: {
        veilManifest: manifest,
        veilSanitation: sanitation,
        veilAdmissionToken: proof.token,
      },
    },
  };
}

async function expectNoReadableArtifacts(fixture: Awaited<ReturnType<typeof createFixture>>) {
  for (const artifact of fixture.artifacts) {
    expect(await fixture.store.exists(artifact.storageKey)).toBe(false);
    await expect(fixture.store.get(artifact.storageKey, artifact.proof)).rejects.toThrow();
  }
}

function readOnlyPlan() {
  return {
    name: "Artifact commit",
    objective: "Open one page",
    preconditions: [],
    allowedOrigins: ["https://example.test"],
    budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "open",
        title: "Open",
        action: { type: "navigate", url: "https://example.test" },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "final",
      },
    ],
  };
}
