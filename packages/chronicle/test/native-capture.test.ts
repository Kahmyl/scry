import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, symlink, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { EvidenceCipher } from "@scry/veil";
import type { NativeCapturePort, NativeCaptureSample } from "@scry/contracts";
import { ChronicleEvidenceService } from "../src/evidence-session.js";
import { AdmittedEvidenceReader } from "../src/admitted-evidence-reader.js";
import {
  createNativeRecording,
  readNativeEvidenceInventory,
  nativeEvidenceInventory,
  recoverNativeCaptures,
} from "../src/native-media.js";
import { evaluateNativeCaptures, recordingAssessment } from "../src/native-capture.js";
import * as durable from "../src/durable-file.js";
import { memoryAdmission } from "./fixtures/evidence-admission.js";
const available = { state: "available", assessment: "best_effort_known_candidates" } as const;
const sample = (id: number, extra: Partial<NativeCaptureSample> = {}): NativeCaptureSample => ({
  version: 1,
  readId: id,
  policyGeneration: 1,
  text: "complete",
  knownRequirement: "present",
  image: available,
  ...extra,
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-v2-")),
    control = memoryAdmission(),
    protection = new EvidenceCipher(randomBytes(32));
  const scope = {
    root,
    admission: control.admission,
    runId: control.stream.runId,
    sessionId: control.stream.sessionId,
    protection,
    maxSessionBytes: 1024 * 1024,
  };
  const renderer = {
    render: vi.fn(async () => {
      throw new Error("native_v2_must_never_replay");
    }),
  };
  const service = new ChronicleEvidenceService(renderer),
    session = await service.openSession(scope);
  const recording = session.createRecording({ snapshot: () => (v) => v });
  const verify = () =>
    new AdmittedEvidenceReader<Record<string, unknown>>({
      directory: path.join(root, "evidence"),
      runId: scope.runId,
      scopeId: scope.sessionId,
      protection,
      admission: control.admission,
    }).verify();
  const native = await createNativeRecording({
    root,
    generation: 1,
    recording,
    verify,
    assertActive: () => control.admission.assertActive(),
  });
  await session.startCapture();
  const inventory = (terminal = false) =>
    readNativeEvidenceInventory({
      root,
      snapshot: structuredClone(control.stream),
      protection,
      allowOpen: true,
      terminal,
    });
  const append = async (event: Record<string, unknown>) => {
    recording.receive(JSON.stringify(event));
    await recording.flush();
  };
  return {
    ...control,
    root,
    scope,
    renderer,
    service,
    session,
    recording,
    native,
    verify,
    inventory,
    append,
  };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "display" | "screencast" = "display",
) {
  const capture = await f.native.reserveCaptureV2({ kind, policyGeneration: 1 });
  await writeFile(
    path.join(capture.directory, capture.filename),
    Buffer.from(`public recording ${capture.epoch.captureId}`),
  );
  return capture;
}
async function stop(c: NativeCapturePort, id = 2) {
  const challenge = await c.physicalStopped({
    epoch: c.epoch,
    started: 1000,
    ended: 2000,
    physicalCoverage: "complete",
  });
  await c.graphSample({
    sequence: 2,
    sample: sample(id, { finalReadChallenge: challenge.challenge }),
  });
  await c.graphClosed({ lastSequence: 2 });
  return c.seal();
}
describe("prospective native capture admission", () => {
  it("registers unique v2 producers and admits sealed captures with canonical inventory", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    expect(await stop(c)).toMatchObject({
      state: "best_effort_assessed",
      observedRequiredGap: false,
    });
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 1,
      recordingAssessment: { state: "best_effort_assessed" },
    });
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({ admitted: 1 });
    expect(await f.inventory()).toMatchObject({
      media: [{ kind: "video", masking: "best_effort" }],
      recordingAssessment: { state: "best_effort_assessed" },
    });
    const events = (await f.verify()).events;
    expect(events.some((e) => e.type === "native_capture_started")).toBe(false);
    expect(events.find((e) => e.type === "native_media")).toMatchObject({
      captureEpoch: c.epoch,
      admittingGeneration: 1,
    });
    await expect(
      c.graphGap({ sequence: 3, reason: "native_protection_geometry_stale" }),
    ).rejects.toThrow("producer_closed");
    const next = await reserve(f, "screencast");
    expect(next.directory).not.toBe(c.directory);
    expect(f.native).not.toHaveProperty("admit");
    expect(f.native).not.toHaveProperty("reserveCapture");
  });
  it.each(["required_gap", "public_transient", "permanent_history"] as const)(
    "preserves %s semantics",
    async (kind) => {
      const f = await fixture(),
        c = await reserve(f);
      const bad =
        kind === "permanent_history"
          ? "native_protection_capacity"
          : "native_protection_refresh_incomplete";
      await c.graphSample({
        sequence: 1,
        sample: sample(1, {
          knownRequirement: kind === "required_gap" ? "present" : "unknown",
          image: {
            state: "withheld",
            reason: bad,
            recovery: bad === "native_protection_capacity" ? "preserve_gap" : "read_only_once",
          } as NativeCaptureSample["image"],
        }),
      });
      const final = await stop(c);
      expect(final.state).toBe(kind === "public_transient" ? "best_effort_assessed" : "withheld");
      expect(final).toMatchObject({ observedRequiredGap: kind === "required_gap" });
      const result = await f.session.recoverNativeCaptures(f.native);
      expect(result.admitted).toBe(kind === "public_transient" ? 1 : 0);
    },
  );
  it("drains queued observed gaps and preserves safe independent still media", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    const gap = c.graphGap({ sequence: 2, reason: "native_protection_geometry_stale" });
    const challenge = await c.physicalStopped({
      epoch: c.epoch,
      started: 1000,
      ended: 2000,
      physicalCoverage: "complete",
    });
    await c.graphSample({
      sequence: 3,
      sample: sample(2, { finalReadChallenge: challenge.challenge }),
    });
    await c.graphClosed({ lastSequence: 3 });
    await gap;
    expect(await c.seal()).toMatchObject({ state: "withheld", observedRequiredGap: true });
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(f.native.directory, filename), randomBytes(64));
    await f.native.admitStill({
      filename,
      imageEvidence: available,
      timestamp: 1000,
      label: "final",
    });
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 0,
      recordingAssessment: { state: "withheld" },
    });
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    expect(await f.session.seal({ renderVideo: true, actionLedger: async () => [] })).toMatchObject(
      { state: "incomplete" },
    );
    expect(await f.inventory()).toMatchObject({
      media: [{ kind: "screenshot" }],
      recordingAssessment: { state: "withheld" },
    });
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it.each([
    "unfinalized",
    "unsealed",
    "stale",
    "higher_pre_stop_id",
    "missing_graph_close",
    "out_of_order",
  ] as const)("withholds %s without replay fallback", async (kind) => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    if (kind !== "unfinalized") {
      const challenge = await c.physicalStopped({
        epoch: c.epoch,
        started: 1000,
        ended: 2000,
        physicalCoverage: "complete",
      });
      await c.graphSample({
        sequence: kind === "out_of_order" ? 4 : 2,
        sample: sample(
          kind === "higher_pre_stop_id" ? 200 : kind === "stale" ? 1 : 2,
          ...(["stale", "higher_pre_stop_id"].includes(kind)
            ? []
            : [{ finalReadChallenge: challenge.challenge }]),
        ),
      });
      if (kind !== "missing_graph_close") await c.graphClosed({ lastSequence: 2 });
      if (kind !== "unsealed") await c.seal();
    }
    expect((await f.session.recoverNativeCaptures(f.native)).admitted).toBe(0);
    if (kind === "unfinalized")
      expect((await f.inventory()).recordingAssessment).toEqual({ state: "pending" });
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    expect((await f.inventory()).recordingAssessment?.state).toBe("withheld");
    const result = await f.session.seal({ renderVideo: true, actionLedger: async () => [] });
    expect(result.videoObjectKey).toBeUndefined();
    expect(result.state).toBe("incomplete");
    expect(result.recordingAssessment?.state).toBe("withheld");
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it("freezes finite samples before queueing and excludes raw graph values", async () => {
    const f = await fixture(),
      c = await reserve(f),
      value = { ...sample(1), values: ["private-never-durable"] };
    const pending = c.graphSample({ sequence: 1, sample: value });
    value.image = {
      state: "withheld",
      reason: "native_protection_capacity",
      recovery: "preserve_gap",
    };
    value.readId = 500;
    await pending;
    await stop(c);
    expect((await f.session.recoverNativeCaptures(f.native)).admitted).toBe(1);
    expect(JSON.stringify((await f.verify()).events)).not.toContain("private-never-durable");
  });
  it("rejects unsafe stills, changed bytes, and aliased capture directories", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    await writeFile(path.join(c.directory, c.filename), "different public bytes");
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 0,
      recordingAssessment: { state: "withheld", reason: "native_capture_bytes_mismatch" },
    });
    await expect(
      f.native.admitStill({
        filename: `${randomUUID()}.png`,
        timestamp: 1,
        label: "final",
        imageEvidence: { state: "withheld" } as never,
      }),
    ).rejects.toThrow("image_evidence_withheld");
    const g = await fixture(),
      d = await reserve(g);
    await d.graphSample({ sequence: 1, sample: sample(1) });
    await stop(d);
    const original = await readFile(path.join(d.directory, d.filename));
    await unlink(path.join(d.directory, d.filename));
    const elsewhere = path.join(g.root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, d.filename), original);
    await symlink(path.join(elsewhere, d.filename), path.join(d.directory, d.filename));
    expect((await g.session.recoverNativeCaptures(g.native)).admitted).toBe(0);
  });
  it.each([
    "duplicate_reservation",
    "conflicting_final",
    "bad_seal",
    "late_gap",
    "unknown_policy",
    "wrong_writer",
  ] as const)("rejects authenticated %s proof", async (kind) => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    const verified = await f.verify(),
      events = structuredClone(verified.events),
      r = events.find((e) => e.type === "native_capture_reserved_v2")!,
      final = events.find((e) => e.type === "native_capture_assessed_v2")!;
    if (kind === "duplicate_reservation") events.push(structuredClone(r));
    if (kind === "conflicting_final") events.push({ ...final, physical: {} });
    if (kind === "bad_seal")
      events.find((e) => e.type === "native_capture_sealed_v2")!.finalDigest = "0".repeat(64);
    if (kind === "late_gap")
      events.push({
        type: "native_capture_gap_v2",
        epoch: c.epoch,
        reason: "native_protection_geometry_stale",
        observedRequiredGap: true,
      });
    if (kind === "unknown_policy")
      (r.epoch as { assessmentPolicyVersion: number }).assessmentPolicyVersion = 999;
    const owners = events.map(() => (kind === "wrong_writer" ? 2 : 1));
    expect(
      evaluateNativeCaptures(events, { ownerGenerations: owners, terminal: true })[0]!.assessment
        .state,
    ).toBe("withheld");
  });
  it("keeps artifact read errors separate from permanent policy decisions", async () => {
    const f = await fixture();
    await reserve(f);
    const receipt = f.stream.chunks[0]!;
    await unlink(path.join(f.root, "evidence", receipt.objectKey));
    await expect(f.inventory()).rejects.toMatchObject({ issue: "object_unavailable" });
    expect(
      recordingAssessment([{ type: "native_capture_started", directory: "historical" }], {
        terminal: true,
      }),
    ).toBeUndefined();
  });
  it("concurrent recovery admits one receipt and owner loss never publishes", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    expect(
      await Promise.all([
        recoverNativeCaptures(f.root, f.native),
        recoverNativeCaptures(f.root, f.native),
      ]),
    ).toMatchObject([{ admitted: 1 }, { admitted: 1 }]);
    expect((await f.verify()).events.filter((e) => e.type === "native_media")).toHaveLength(1);
    const g = await fixture(),
      d = await reserve(g);
    await d.graphSample({ sequence: 1, sample: sample(1) });
    await stop(d);
    g.revoke();
    await expect(g.session.recoverNativeCaptures(g.native)).rejects.toThrow("OWNER_FENCED");
  });
  it("recovers under a new owner while preserving original writer lineage", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    f.stream.writerGeneration = 2;
    const replacement = await f.service.openSession({
      ...f.scope,
      admission: { ...f.admission, ownerGeneration: 2 },
    });
    const native = await replacement.createNativeRecording();
    expect(await replacement.recoverNativeCaptures(native)).toMatchObject({
      admitted: 1,
      recordingAssessment: { state: "best_effort_assessed" },
    });
    const verified = await f.verify(),
      media = verified.events.find((e) => e.type === "native_media")!;
    expect(media).toMatchObject({
      captureEpoch: { originalWriterGeneration: 1 },
      admittingGeneration: 2,
      media: { objectKey: expect.stringMatching(/^native\/2\//) },
    });
    expect(verified.eventOwnerGenerations[verified.events.indexOf(media)]).toBe(2);
    expect((await f.inventory()).media).toHaveLength(1);
  });
  it("retains safe independently admitted video when a sibling capture is withheld", async () => {
    const f = await fixture(),
      safe = await reserve(f);
    await safe.graphSample({ sequence: 1, sample: sample(1) });
    await stop(safe);
    const withheld = await reserve(f, "screencast");
    await withheld.graphSample({
      sequence: 1,
      sample: sample(1, { observedRequiredGap: "native_protection_geometry_unsupported" }),
    });
    await stop(withheld);
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 1,
      recordingAssessment: { state: "withheld" },
    });
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    const completion = await f.session.seal({ renderVideo: true, actionLedger: async () => [] });
    expect(completion).toMatchObject({ state: "incomplete", videoObjectKey: expect.any(String) });
    expect((await f.inventory()).media).toMatchObject([{ kind: "video" }]);
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it("persists finite admission failure independently of an assessed final", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    const failure = vi
      .spyOn(durable, "durableWrite")
      .mockRejectedValueOnce(
        Object.assign(new Error("do not disclose private path"), { code: "EACCES" }),
      );
    try {
      expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
        admitted: 0,
        recordingAssessment: { state: "withheld", reason: "native_capture_admission_unavailable" },
      });
    } finally {
      failure.mockRestore();
    }
    const events = (await f.verify()).events;
    expect(events.find((e) => e.type === "native_capture_assessed_v2")).toMatchObject({
      assessment: { state: "best_effort_assessed" },
    });
    expect(events.find((e) => e.type === "native_capture_admission_failed_v2")).toMatchObject({
      reason: "native_capture_admission_unavailable",
    });
    expect(events.some((e) => e.type === "native_media")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("do not disclose private path");
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    expect((await f.inventory()).recordingAssessment).toMatchObject({ state: "withheld" });
  });
  it("rejects a late authenticated callback without promoting bytes", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    await f.append({
      type: "native_capture_gap_v2",
      epoch: c.epoch,
      reason: "native_protection_geometry_stale",
      observedRequiredGap: true,
    });
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 0,
      recordingAssessment: { state: "withheld" },
    });
    expect((await f.verify()).events.some((e) => e.type === "native_media")).toBe(false);
  });
  it("drains an accepted observed callback before producer closure", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    const challenge = await c.physicalStopped({
      epoch: c.epoch,
      started: 1000,
      ended: 2000,
      physicalCoverage: "complete",
    });
    await c.graphSample({
      sequence: 2,
      sample: sample(2, { finalReadChallenge: challenge.challenge }),
    });
    const accepted = c.graphGap({ sequence: 3, reason: "native_protection_geometry_stale" });
    const closing = c.graphClosed({ lastSequence: 3 });
    const sealing = c.seal();
    await accepted;
    await closing;
    expect(await sealing).toMatchObject({ state: "withheld", observedRequiredGap: true });
    const verified = await f.verify();
    for (let end = 1; end <= verified.events.length; end++)
      expect(
        recordingAssessment(verified.events.slice(0, end), {
          terminal: true,
          ownerGenerations: verified.eventOwnerGenerations.slice(0, end),
        })?.state,
      ).not.toBe("best_effort_assessed");
    expect((await f.session.recoverNativeCaptures(f.native)).admitted).toBe(0);
  });
  it("admits acknowledged policy transitions and preserves physical partial coverage", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await c.policyTransition({ from: 1, to: 2, acknowledged: true });
    const receipt = {
      epoch: c.epoch,
      started: 1000,
      ended: 1800,
      physicalCoverage: "partial" as const,
    };
    const challenge = await c.physicalStopped(receipt);
    expect(await c.physicalStopped(receipt)).toEqual(challenge);
    await c.graphSample({
      sequence: 2,
      sample: sample(4, { policyGeneration: 2, finalReadChallenge: challenge.challenge }),
    });
    await c.graphClosed({ lastSequence: 2 });
    await c.graphClosed({ lastSequence: 2 });
    expect(await c.seal()).toMatchObject({
      state: "best_effort_assessed",
      policy: { first: 1, last: 2, transitions: 1 },
    });
    expect((await f.session.recoverNativeCaptures(f.native)).admitted).toBe(1);
    expect((await f.inventory()).media).toMatchObject([{ coverage: "partial", durationMs: 800 }]);
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    expect(f.stream.captureComplete).toBe(false);
  });
  it("withholds orphan v2 proof without authorizing a replay fallback", async () => {
    const f = await fixture();
    await f.append({
      type: "native_capture_sealed_v2",
      epoch: { captureId: randomUUID(), originalWriterGeneration: 1, assessmentPolicyVersion: 2 },
      finalDigest: "0".repeat(64),
    });
    expect(await f.session.recoverNativeCaptures(f.native)).toMatchObject({
      admitted: 0,
      recordingAssessment: { state: "withheld", reason: "native_capture_identity_mismatch" },
    });
    await f.session.stopCapture({ browserStopped: true, recordingDrained: true });
    expect(await f.session.seal({ renderVideo: true, actionLedger: async () => [] })).toMatchObject(
      { state: "incomplete" },
    );
    expect(f.renderer.render).not.toHaveBeenCalled();
  });
  it("does not downgrade a v2 receipt missing its wrapper into legacy media", async () => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    await stop(c);
    await f.session.recoverNativeCaptures(f.native);
    const verified = await f.verify(),
      event = verified.events.find((e) => e.type === "native_media")!;
    delete event.captureEpoch;
    expect(nativeEvidenceInventory(verified, f.stream, true)).toMatchObject({
      media: [],
      recordingAssessment: { state: "withheld", reason: "native_capture_identity_mismatch" },
    });
    const malformed = {
      ...verified,
      events: [
        { type: "native_capture_reserved_v2" },
        ...verified.events.filter((e) => e.type === "native_media"),
      ],
    };
    expect(() => nativeEvidenceInventory(malformed, f.stream, true)).not.toThrow();
  });
  it.each(["native_capture_assessed_v2", "native_capture_sealed_v2"])(
    "rejects a revoked callback while %s awaits authenticated I/O",
    async (target) => {
      const f = await fixture(),
        c = await reserve(f);
      await c.graphSample({ sequence: 1, sample: sample(1) });
      const challenge = await c.physicalStopped({
        epoch: c.epoch,
        started: 1000,
        ended: 2000,
        physicalCoverage: "complete",
      });
      await c.graphSample({
        sequence: 2,
        sample: sample(2, { finalReadChallenge: challenge.challenge }),
      });
      await c.graphClosed({ lastSequence: 2 });
      let release!: () => void,
        entered!: () => void,
        lastType = "",
        paused = false;
      const gate = new Promise<void>((resolve) => (release = resolve)),
        ready = new Promise<void>((resolve) => (entered = resolve));
      const receive = f.recording.receive.bind(f.recording),
        flush = f.recording.flush.bind(f.recording);
      const receiveSpy = vi.spyOn(f.recording, "receive").mockImplementation((payload) => {
        lastType = JSON.parse(payload).type;
        receive(payload);
      });
      const flushSpy = vi.spyOn(f.recording, "flush").mockImplementation(async () => {
        if (lastType === target && !paused) {
          paused = true;
          entered();
          await gate;
        }
        return flush();
      });
      try {
        const sealing = c.seal();
        await ready;
        const late = c
          .graphGap({ sequence: 3, reason: "native_protection_geometry_stale" })
          .catch((error) => error);
        const verifying = vi.spyOn(AdmittedEvidenceReader.prototype, "verify");
        const recovering = recoverNativeCaptures(f.root, f.native);
        try {
          await Promise.resolve();
          await Promise.resolve();
          expect(verifying).not.toHaveBeenCalled();
        } finally {
          verifying.mockRestore();
        }
        release();
        expect(await sealing).toMatchObject({
          state: "best_effort_assessed",
          observedRequiredGap: false,
        });
        expect(await late).toBeInstanceOf(Error);
        expect(await recovering).toMatchObject({
          admitted: 1,
          recordingAssessment: { state: "best_effort_assessed" },
        });
        expect((await f.verify()).events.some((e) => e.type === "native_capture_gap_v2")).toBe(
          false,
        );
      } finally {
        release();
        receiveSpy.mockRestore();
        flushSpy.mockRestore();
      }
    },
  );
  it("does not treat a historical interruption as retirement of a current writer", async () => {
    const f = await fixture();
    await reserve(f);
    f.stream.interruptions = 1;
    expect((await f.inventory()).recordingAssessment).toEqual({ state: "pending" });
    f.stream.writerGeneration = 2;
    expect((await f.inventory()).recordingAssessment).toMatchObject({
      state: "withheld",
      reason: "native_capture_final_assessment_missing",
    });
  });
  it.each([
    ["native_capture_assessed_v2", "before_write"],
    ["native_capture_assessed_v2", "lost_ack"],
    ["native_capture_sealed_v2", "before_write"],
    ["native_capture_sealed_v2", "lost_ack"],
  ] as const)("retains explicit seal failure for %s %s exact retry", async (target, mode) => {
    const f = await fixture(),
      c = await reserve(f);
    await c.graphSample({ sequence: 1, sample: sample(1) });
    const challenge = await c.physicalStopped({
      epoch: c.epoch,
      started: 1000,
      ended: 2000,
      physicalCoverage: "complete",
    });
    await c.graphSample({
      sequence: 2,
      sample: sample(2, { finalReadChallenge: challenge.challenge }),
    });
    await c.graphClosed({ lastSequence: 2 });
    let type = "",
      injected = false;
    const receive = f.recording.receive.bind(f.recording),
      flush = f.recording.flush.bind(f.recording);
    const receiveSpy = vi.spyOn(f.recording, "receive").mockImplementation((payload) => {
      type = JSON.parse(payload).type;
      receive(payload);
    });
    const flushSpy = vi.spyOn(f.recording, "flush").mockImplementation(async () => {
      if (type === target && !injected) {
        injected = true;
        if (mode === "lost_ack") await flush();
        throw new Error("fixture_seal_append_failure");
      }
      return flush();
    });
    try {
      const failed = c.seal();
      await expect(failed).rejects.toThrow("fixture_seal_append_failure");
      await expect(c.seal()).rejects.toThrow("fixture_seal_append_failure");
      flushSpy.mockRestore();
      receiveSpy.mockRestore();
      expect((await f.session.recoverNativeCaptures(f.native)).admitted).toBe(
        target === "native_capture_sealed_v2" && mode === "lost_ack" ? 1 : 0,
      );
    } finally {
      flushSpy.mockRestore();
      receiveSpy.mockRestore();
      await f.recording.abort();
    }
  });
});
