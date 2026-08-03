import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
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
});
