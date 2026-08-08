import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import { registerVeilEvidenceAdmission } from "../src/artifacts.js";
import { TraceCoordinator } from "../src/trace-coordinator.js";

describe("TraceCoordinator admission", () => {
  it("destroys a sanitized trace when complete classification is unproven", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "veil-trace-admission-"));
    let tracePath = "";
    const tracing = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async ({ path: target }: { path: string }) => {
        tracePath = target;
        await writeFile(
          target,
          zipSync({ "trace.trace": Buffer.from("unknown protected material") }),
        );
      }),
    };
    const coordinator = new TraceCoordinator({
      context: { tracing } as never,
      outputDirectory: root,
      sanitize: async () => undefined,
    });
    await coordinator.start("run_started");
    await coordinator.finalize();
    const [artifact] = coordinator.artifacts();
    expect(artifact).toMatchObject({
      kind: "trace",
      availability: "destroyed",
      reasonCode: "TRACE_CLASSIFICATION_UNPROVEN",
    });
    await expect(readFile(tracePath)).rejects.toBeDefined();
  });

  it("admits a sanitized trace only after authoritative classification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "veil-trace-admission-"));
    const tracing = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async ({ path: target }: { path: string }) => {
        await writeFile(target, zipSync({ "trace.trace": Buffer.from("public trace") }));
      }),
    };
    const classify = vi.fn(async () => true);
    const authority = new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://trace.test"] }),
    );
    const unregister = registerVeilEvidenceAdmission({
      root,
      authority,
      admissionKey: "trace-test-veil-admission-key-32-bytes",
      context: () => ({
        userId: "test",
        environmentId: "test",
        transactionId: "trace-test",
        origin: "https://trace.test",
        browserContextId: "context",
        pageId: "page",
        frameId: "main",
        documentEpoch: 1,
      }),
    });
    const coordinator = new TraceCoordinator({
      context: { tracing } as never,
      outputDirectory: root,
      sanitize: async () => undefined,
      admitSanitized: classify,
    });
    try {
      await coordinator.start("run_started");
      await coordinator.finalize();
      expect(classify).toHaveBeenCalledOnce();
      expect(coordinator.artifacts()[0]).toMatchObject({
        kind: "trace",
        availability: "available",
      });
    } finally {
      unregister();
    }
  });
});
