import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChronicleReplayPlan } from "@scry/contracts";
import { EvidenceCipher } from "@scry/veil";
import { ChronicleEvidenceService, renderSanitizedReplay } from "../src/index.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

describe("owner admission at evidence durability", () => {
  it("rejects a stale buffered recording without changing its manifest", async () => {
    const { admission, stream, revoke } = memoryAdmission("session", "run");
    const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-owner-"));
    const scope = {
      root,
      runId: "run",
      sessionId: "session",
      maxSessionBytes: 1024 * 1024,
      protection: new EvidenceCipher(randomBytes(32)),
      admission,
    };
    const session = await new ChronicleEvidenceService({
      render: async () => {
        throw new Error("unused");
      },
    }).openSession(scope);
    const recording = session.createRecording({ snapshot: () => (value) => value });
    recording.receive('{"first":true}');
    await recording.flush();
    const objectPath = path.join(root, "evidence", stream.chunks[0]!.objectKey);
    const before = await readFile(objectPath, "utf8");
    revoke();
    recording.receive('{"stale":true}');
    await expect(recording.flush()).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    expect(await readFile(objectPath, "utf8")).toBe(before);
    expect(stream.chunks).toHaveLength(1);
  });

  it("does not publish replay artifacts after ownership is replaced during rendering", async () => {
    const { admission, revoke } = memoryAdmission();
    const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-render-owner-"));
    const options = {
      admission,
      outputDirectory: path.join(root, "rendered"),
      ledgerPath: path.join(root, "actions.jsonl"),
      events: [{ timestamp: 1000, type: 2 }],
      renderer: {
        async render(plan: ChronicleReplayPlan) {
          const videoPath = path.join(plan.stagingDirectory, "fixture.webm");
          await writeFile(videoPath, "video");
          for (const [index] of plan.frames.entries())
            await writeFile(path.join(plan.framesDirectory, `frame-${index}.png`), "frame");
          revoke();
          return {
            videoPath,
            replayFailed: false,
            networkRequests: 0,
            visibleFrameCount: plan.frames.length,
          };
        },
      },
    };
    await expect(renderSanitizedReplay(options)).rejects.toThrow("SCRY_BROWSER_OWNER_FENCED");
    await expect(access(path.join(options.outputDirectory, "publication.json"))).rejects.toThrow();
  });
});
