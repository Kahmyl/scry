import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingCoordinator } from "../src/recording-coordinator.js";
import { registerVeilEvidenceAdmission } from "../src/artifacts.js";
import { VeilAuthority } from "@scry/veil";
import { compileVeilPolicy } from "@scry/veil";

const roots: string[] = [];
const unregister: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const dispose of unregister.splice(0)) dispose();
});

async function fixture(
  options: { failStart?: boolean; failStop?: boolean; omitFile?: boolean; closed?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scry-recording-"));
  roots.push(root);
  let activePath: string | undefined;
  const startInputs: Array<{ path?: string; size?: { width: number; height: number } }> = [];
  const page = {
    isClosed: () => options.closed ?? false,
    screencast: {
      start: async (input: { path?: string; size?: { width: number; height: number } }) => {
        if (options.failStart) throw new Error("start failed");
        startInputs.push(input);
        activePath = input.path;
      },
      stop: async () => {
        if (options.failStop) throw new Error("stop failed");
        if (!activePath) throw new Error("not active");
        if (!options.omitFile) await writeFile(activePath, Buffer.from("synthetic-webm-segment"));
        activePath = undefined;
      },
    },
  } as unknown as Page;
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const videoFinalization = {
    schemaVersion: 1 as const,
    segmentId: "segment",
    segmentPermitDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    contextDigest: "c".repeat(64),
    documentEpoch: 1,
    checkpointCount: 2,
    checkpointChainDigest: "d".repeat(64),
    finalizedAt: new Date().toISOString(),
  };
  const videoAuthority = {
    issue: (segmentId: string) => ({
      schemaVersion: 1,
      token: `veil_video_${"a".repeat(43)}`,
      segmentId,
      policyDigest: "b".repeat(64),
      contextDigest: "c".repeat(64),
      browserContextId: "context",
      pageId: "page",
      frameId: "main",
      documentEpoch: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    checkpoint: async () => undefined,
    finalize: () => videoFinalization,
  };
  const coordinator = new RecordingCoordinator({
    outputDirectory: root,
    emit: async (type, payload) => {
      events.push({ type, payload });
    },
    videoAuthority: videoAuthority as never,
    videoBinding: () => ({
      browserContextId: "context",
      pageId: "page",
      frameId: "main",
      documentEpoch: 1,
    }),
  });
  const authority = new VeilAuthority(
    compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://recording.test"] }),
  );
  unregister.push(
    registerVeilEvidenceAdmission({
      root,
      authority,
      admissionKey: "recording-test-veil-admission-key-32-bytes",
      videoAdmission: (finalization) => finalization,
      context: () => ({
        userId: "test",
        environmentId: "test",
        transactionId: "recording-test",
        origin: "https://recording.test",
        browserContextId: "context",
        pageId: "page",
        frameId: "main",
        documentEpoch: 1,
      }),
    }),
  );
  return { root, page, coordinator, events, startInputs };
}

describe("RecordingCoordinator", () => {
  it("inherits the shared screencast dimensions instead of forcing a padded canvas", async () => {
    const { page, coordinator, startInputs } = await fixture();
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.finalize();

    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]).toEqual({ path: expect.stringMatching(/\.webm$/) });
    expect(startInputs[0]).not.toHaveProperty("size");
  });

  it("creates permitted segments around a protected gap", async () => {
    const { root, page, coordinator } = await fixture();
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.createProtectedGap({
      operationId: "synthetic-gap",
      reason: "Phase 1 feasibility",
    });
    await coordinator.startSegment({ reason: "safe_resume" });
    await coordinator.finalize();

    const timeline = coordinator.timeline();
    expect(timeline.map((entry) => entry.type)).toEqual([
      "video_segment",
      "protected_gap",
      "video_segment",
    ]);
    expect(timeline.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(coordinator.artifacts()).toHaveLength(2);
    for (const artifact of coordinator.artifacts()) {
      expect(artifact.availability).toBe("available");
      expect((await readFile(path.join(root, artifact.relativePath!))).length).toBeGreaterThan(0);
    }
  });

  it("serializes concurrent finalizers and emits one segment", async () => {
    const { page, coordinator } = await fixture();
    await coordinator.startSegment({ page, reason: "run_started" });
    await Promise.all([coordinator.finalize(), coordinator.finalize(), coordinator.finalize()]);
    expect(coordinator.timeline()).toHaveLength(1);
    expect(coordinator.artifacts()).toHaveLength(1);
  });

  it("seals and quarantines an active segment", async () => {
    const { page, coordinator, events } = await fixture();
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.seal("BROWSER_CLOSED");
    await coordinator.finalize();
    expect(coordinator.isSealed()).toBe(true);
    expect(coordinator.timeline()[0]).toEqual(
      expect.objectContaining({ status: "quarantined", privacyStatus: "quarantined" }),
    );
    expect(coordinator.artifacts()[0]).toEqual(
      expect.objectContaining({ availability: "destroyed", privacyClassification: "uncertain" }),
    );
    expect(events.some((event) => event.type === "recording.sealed")).toBe(true);
  });

  it("records an unavailable interval and seals when screencast start fails", async () => {
    const { page, coordinator } = await fixture({ failStart: true });
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.finalize();
    expect(coordinator.timeline()).toEqual([
      expect.objectContaining({
        type: "unavailable_interval",
        failureCode: "SCREENCAST_START_FAILED",
      }),
    ]);
    expect(coordinator.isSealed()).toBe(true);
  });

  it("quarantines the segment and seals when screencast stop fails", async () => {
    const { page, coordinator } = await fixture({ failStop: true });
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.finalize();
    expect(coordinator.timeline()[0]).toEqual(
      expect.objectContaining({ status: "failed", failureCode: "SCREENCAST_STOP_FAILED" }),
    );
    expect(coordinator.isSealed()).toBe(true);
  });

  it("seals when a completed segment cannot be validated from storage", async () => {
    const { page, coordinator } = await fixture({ omitFile: true });
    await coordinator.startSegment({ page, reason: "run_started" });
    await coordinator.finalize();
    expect(coordinator.timeline()[0]).toEqual(
      expect.objectContaining({ status: "failed", failureCode: "SEGMENT_VALIDATION_FAILED" }),
    );
    expect(coordinator.isSealed()).toBe(true);
  });

  it("seals rather than switching to a closed page", async () => {
    const { page, coordinator } = await fixture({ closed: true });
    await coordinator.startSegment({ page, reason: "run_started" });
    expect(coordinator.isSealed()).toBe(true);
    expect(coordinator.timeline()[0]).toEqual(
      expect.objectContaining({ type: "unavailable_interval" }),
    );
  });
});
