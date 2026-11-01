import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import { ChronicleEvidenceService, renderSanitizedReplay } from "../src/index.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";

const fault = vi.hoisted(() => ({ stage: "", error: undefined as Error | undefined, used: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const refuse = (stage: string, matches: boolean) => {
    if (matches && fault.stage === stage && fault.error && !fault.used) {
      fault.used = true;
      throw fault.error;
    }
  };
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      refuse("staging", String(args[0]).includes("rendered.partial-"));
      refuse("parent", String(args[0]).endsWith("parent-probe"));
      return actual.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      refuse("video", String(args[1]).endsWith("sanitized-replay.webm"));
      refuse("final", path.basename(String(args[1])) === "rendered");
      return actual.rename(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      refuse("frames", String(args[0]).includes("rendered.partial-"));
      return actual.readdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      refuse("publication", String(args[0]).endsWith("publication.json"));
      return actual.writeFile(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      refuse("ledger", String(args[0]).endsWith("actions.jsonl"));
      refuse("cached", String(args[0]).endsWith("rendered/publication.json"));
      return actual.readFile(...args);
    },
  };
});
afterEach(() => {
  fault.stage = "";
  fault.error = undefined;
  fault.used = false;
});
async function captured() {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const control = memoryAdmission();
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-replay-fs-"));
  const renderer = {
    render: vi.fn(async (plan: import("@scry/contracts").ChronicleReplayPlan) => {
      const videoPath = path.join(plan.stagingDirectory, "fixture.webm");
      await actual.writeFile(videoPath, "fictional video");
      await actual.writeFile(
        path.join(plan.framesDirectory, "frame-0.png"),
        "fictional protected frame",
      );
      return {
        videoPath,
        replayFailed: false,
        networkRequests: 0,
        visibleFrameCount: plan.frames.length,
      };
    }),
  };
  const service = new ChronicleEvidenceService(renderer);
  const scope = {
    admission: control.admission,
    runId: control.stream.runId,
    sessionId: control.stream.sessionId,
    root,
    protection: new EvidenceCipher(randomBytes(32)),
    maxSessionBytes: 1048576,
  };
  const capture = await service.openSession(scope);
  capture
    .createRecording({ snapshot: () => (value) => value })
    .receive('{"type":2,"timestamp":1000}');
  await capture.startCapture();
  await capture.prepareClosure();
  await capture.stopCapture({ browserStopped: true, recordingDrained: true });
  return { ...control, scope, renderer, service };
}
describe("known replay filesystem operations only", () => {
  it.each(["staging", "video", "frames", "publication", "final"])(
    "failed-run closure classifies %s ENOSPC and retains verified capture, never a video",
    async (stage) => {
      const f = await captured();
      const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
      fault.stage = stage;
      fault.error = Object.assign(new Error("fixture_private_filesystem_detail"), {
        code: "ENOSPC",
      });
      const completion = await closure.seal({
        failureClosure: true,
        renderVideo: true,
        actionLedger: async () => [],
      });
      expect(fault.used).toBe(true);
      expect(completion).toMatchObject({
        state: "incomplete",
        issue: "video_unavailable",
        chainHead: f.stream.chainHead,
        replayObjectKey: expect.stringContaining("evidence.json"),
      });
      expect(completion.videoObjectKey).toBeUndefined();
    },
  );
  it("classifies parent-directory EACCES before invoking the renderer", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "chronicle-parent-fs-"));
    const render = vi.fn();
    fault.stage = "parent";
    fault.error = Object.assign(new Error("fixture_private_permission_detail"), { code: "EACCES" });
    await expect(
      renderSanitizedReplay({
        admission: memoryAdmission().admission,
        renderer: { render },
        events: [{ type: 2, timestamp: 1000 }],
        ledgerPath: path.join(parent, "ledger"),
        outputDirectory: path.join(parent, "parent-probe", "rendered"),
      }),
    ).rejects.toMatchObject({ name: "EvidenceArtifactFailure", issue: "video_unavailable" });
    expect(fault.used).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });
  it.each(["ledger", "cached"])(
    "does not turn %s EIO into an empty ledger or cache miss",
    async (stage) => {
      const f = await captured();
      const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
      fault.stage = stage;
      fault.error = Object.assign(new Error("fixture_private_read_detail"), { code: "EIO" });
      expect(
        await closure.seal({
          failureClosure: true,
          renderVideo: true,
          actionLedger: async () => [],
        }),
      ).toMatchObject({ state: "incomplete", issue: "video_unavailable" });
      expect(fault.used).toBe(true);
      expect(f.renderer.render).not.toHaveBeenCalled();
    },
  );
  it("does not classify a renderer exception merely because it carries a filesystem-like code", async () => {
    const f = await captured();
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    const unknown = Object.assign(new Error("fixture_unknown_control_failure"), { code: "ENOSPC" });
    f.renderer.render.mockRejectedValueOnce(unknown);
    await expect(
      closure.seal({ failureClosure: true, renderVideo: true, actionLedger: async () => [] }),
    ).rejects.toBe(unknown);
  });
  it("required normal closure still refuses a known publication failure", async () => {
    const f = await captured();
    const closure = await f.service.openSession({ ...f.scope, purpose: "closure" });
    fault.stage = "publication";
    fault.error = Object.assign(new Error("fixture_private_write_detail"), { code: "ENOSPC" });
    await expect(
      closure.seal({ renderVideo: true, actionLedger: async () => [] }),
    ).rejects.toMatchObject({ name: "EvidenceArtifactFailure", issue: "video_unavailable" });
  });
});
