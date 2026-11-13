import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  ChronicleNativeRecordingPort,
  NativeMediaReceipt,
  EvidenceStreamSnapshot,
  EvidenceReadProtectionPort,
  NativeCaptureRecovery,
  NativeCaptureEpoch,
  RecordingAssessment,
} from "@scry/contracts";
import type { ChronicleRecording } from "./recording.js";
import type { EvidenceVerification } from "./admitted-evidence-reader.js";
import {
  createNativeCapture,
  evaluateNativeCaptures,
  recordingAssessment,
  type CaptureReservation,
} from "./native-capture.js";

type NativeInput = Omit<
  NativeMediaReceipt,
  "objectKey" | "digest" | "bytes" | "timingOrigin" | "masking"
> & {
  filename: string;
  timingOrigin?: NativeMediaReceipt["timingOrigin"];
  masking?: NativeMediaReceipt["masking"];
};
type NativeInternal = {
  generation: number;
  recording: ChronicleRecording;
  assertActive(): void;
  verify(): Promise<EvidenceVerification<Record<string, unknown>>>;
  append(event: Record<string, unknown>): Promise<void>;
  restoreLegacyDiagnostics(events: Record<string, unknown>[]): void;
  joinCaptures(): Promise<void>;
  admit(
    input: NativeInput,
    proof?: { epoch: NativeCaptureEpoch; sealDigest: string; bytesDigest: string; bytes: number },
  ): Promise<void>;
};
const internals = new WeakMap<ChronicleNativeRecordingPort, NativeInternal>();
import {
  maskingDiagnosticSchema,
  maskingDiagnosticsSchema,
  type MaskingDiagnostic,
} from "@scry/contracts";
import { ensurePrivateDirectory, durableWrite } from "./durable-file.js";
import { AdmittedEvidenceReader } from "./admitted-evidence-reader.js";
import {
  EvidenceArtifactFailure,
  isArtifactFilesystemFailure,
} from "./evidence-artifact-failure.js";

export const nativeEvidenceWarning =
  "Automatic redaction is best effort. Sensitive information may remain. Review before sharing.";

export async function createNativeRecording(options: {
  root: string;
  generation: number;
  recording: ChronicleRecording;
  assertActive(): void;
  verify(): Promise<EvidenceVerification<Record<string, unknown>>>;
}): Promise<ChronicleNativeRecordingPort> {
  const directory = path.join(options.root, "native", String(options.generation), randomUUID());
  await ensurePrivateDirectory(directory);
  options.assertActive();
  let usedBytes = 0,
    maskingUnavailable = false,
    maskingTruncated = false;
  const admitted = new Set<string>(),
    screenshotDigests = new Set<string>(),
    maskingEvents: MaskingDiagnostic[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const append = async (event: Record<string, unknown>) => {
    options.assertActive();
    options.recording.assertActive();
    options.recording.receive(JSON.stringify(event));
    const diagnostics = await options.recording.flush();
    options.assertActive();
    if (diagnostics.errors.length) throw new Error("native_media_admission_failed");
  };
  const admit = async (
    candidate: NativeInput,
    proof?: { epoch: NativeCaptureEpoch; sealDigest: string; bytesDigest: string; bytes: number },
  ) => {
    const input = structuredClone(candidate);
    return serial(async () => {
      options.assertActive();
      options.recording.assertActive();
      if (
        !/^[a-f0-9-]{36}\.(?:webm|mp4|png|jpeg|webp)$/u.test(input.filename) ||
        !Number.isSafeInteger(input.timestamp) ||
        !["initial", "navigate", "fill", "click", "press", "commit", "final", "page"].includes(
          input.label,
        ) ||
        (input.kind === "video"
          ? !/\.(webm|mp4)$/u.test(input.filename)
          : !/\.(png|jpeg|webp)$/u.test(input.filename)) ||
        (input.durationMs !== undefined &&
          (!Number.isFinite(input.durationMs) || input.durationMs < 0)) ||
        !validPresentation(input)
      )
        throw new Error("native_media_receipt_invalid");
      if (admitted.has(input.filename)) return;
      const file = path.join(directory, input.filename);
      const bytes = await privateFile(file, directory, 128 * 1024 * 1024);
      if (usedBytes + bytes.length > 256 * 1024 * 1024)
        throw new Error("native_media_capacity_exceeded");
      const digest = hash(bytes);
      if (proof && (digest !== proof.bytesDigest || bytes.length !== proof.bytes))
        throw new Error("native_capture_bytes_mismatch");
      if (input.kind === "screenshot" && screenshotDigests.has(digest)) {
        // Only this new, unadmitted duplicate is discarded. Never remove the
        // original admitted screenshot or keep charging storage for no change.
        await unlink(file);
        return;
      }
      // Browser encoders finish before admission. Make those final bytes and
      // their directory entry durable before admitting their metadata receipt.
      for (const target of [file, directory]) {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const receipt: NativeMediaReceipt = {
        masking: maskingUnavailable
          ? "unavailable"
          : input.kind === "video" &&
              (maskingTruncated || maskingEvents.some((e) => e.state === "degraded"))
            ? "best_effort_partial"
            : (input.masking ?? "best_effort"),
        ...(maskingEvents.length || maskingTruncated
          ? { maskingDiagnostics: { events: [...maskingEvents], truncated: maskingTruncated } }
          : {}),
        ...(input.coverage ? { coverage: input.coverage } : {}),
        kind: input.kind,
        objectKey: path.relative(options.root, file),
        digest,
        bytes: bytes.length,
        timestamp: input.timestamp,
        label: input.label,
        ...(input.title ? { title: input.title } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.interruptionReason ? { interruptionReason: input.interruptionReason } : {}),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.timingOrigin ? { timingOrigin: input.timingOrigin } : {}),
      };
      options.assertActive();
      options.recording.receive(
        JSON.stringify({
          type: "native_media",
          timestamp: input.timestamp,
          media: receipt,
          ...(proof
            ? {
                captureEpoch: proof.epoch,
                captureSealDigest: proof.sealDigest,
                admittingGeneration: options.generation,
              }
            : {}),
        }),
      );
      const diagnostics = await options.recording.flush();
      options.assertActive();
      if (diagnostics.errors.length) throw new Error("native_media_admission_failed");
      usedBytes += bytes.length;
      admitted.add(input.filename);
      if (input.kind === "screenshot") screenshotDigests.add(digest);
    });
  };
  const captureBarriers = new Set<() => Promise<void>>();
  const native: ChronicleNativeRecordingPort = {
    directory,
    recordMasking(event) {
      options.assertActive();
      const safe = maskingDiagnosticSchema.parse(event);
      if (maskingEvents.length >= 256) {
        if (!maskingTruncated)
          options.recording.receive(
            JSON.stringify({ type: "native_masking_truncated", timestamp: safe.at }),
          );
        maskingTruncated = true;
        return;
      }
      maskingEvents.push(safe);
      options.recording.receive(
        JSON.stringify({ type: "native_masking", timestamp: safe.at, event: safe }),
      );
    },

    maskingUnavailable() {
      maskingUnavailable = true;
    },
    async reserveCaptureV2(input) {
      const { kind, policyGeneration } = input;
      options.assertActive();
      if (
        !["display", "screencast"].includes(kind) ||
        !Number.isSafeInteger(policyGeneration) ||
        policyGeneration < 1
      )
        throw new Error("native_capture_identity_mismatch");
      const epoch = {
        captureId: randomUUID(),
        originalWriterGeneration: options.generation,
        assessmentPolicyVersion: 2 as const,
      };
      const captureDirectory = path.join(directory, "capture-v2", epoch.captureId);
      await ensurePrivateDirectory(captureDirectory);
      const reservation: CaptureReservation = {
        type: "native_capture_reserved_v2",
        epoch,
        directory: path.relative(options.root, captureDirectory),
        kind,
        filename: kind === "display" ? "recording.mp4" : "recording.webm",
        initialPolicyGeneration: policyGeneration,
        requiredProducers: ["graph", "physical"],
      };
      return createNativeCapture({
        reservation,
        directory: captureDirectory,
        append,
        assertActive: options.assertActive,
        registerBarrier: (join) => captureBarriers.add(join),
        readPhysical: async (receipt) => {
          const bytes = await captureFile(
            path.join(captureDirectory, reservation.filename),
            options.root,
          );
          return { ...receipt, bytes: bytes.length, bytesDigest: hash(bytes) };
        },
      });
    },
    async admitStill(input) {
      if (
        input.imageEvidence?.state !== "available" ||
        input.imageEvidence.assessment !== "best_effort_known_candidates"
      )
        throw new Error("native_image_evidence_withheld");
      const { imageEvidence: _, ...candidate } = input;
      return admit({ ...candidate, kind: "screenshot" });
    },
    flush: () => options.recording.flush(),
    abort: () => options.recording.abort(),
    recordError: (code, error) => options.recording.recordError(code, error),
  };
  internals.set(native, {
    generation: options.generation,
    recording: options.recording,
    assertActive: options.assertActive,
    verify: options.verify,
    append,
    admit,
    async joinCaptures() {
      await Promise.all([...captureBarriers].map((join) => join()));
    },
    restoreLegacyDiagnostics(events) {
      const restored = events
        .filter((e) => e.type === "native_masking")
        .slice(0, 256)
        .map((e) => maskingDiagnosticSchema.safeParse(e.event))
        .flatMap((p) => (p.success ? [p.data] : []));
      for (const event of restored)
        if (!maskingEvents.some((e) => JSON.stringify(e) === JSON.stringify(event)))
          maskingEvents.push(event);
      maskingTruncated ||= events.some((e) => e.type === "native_masking_truncated");
    },
  });
  return native;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
const interruptionReasons = new Set([
  "recording_capacity",
  "recording_duration",
  "browser_interrupted",
  "parent_lost",
  "recorder_lost",
  "encoder_start_failed",
  "recorder_terminated",
  "unknown",
]);
function validPresentation(item: {
  title?: unknown;
  description?: unknown;
  interruptionReason?: unknown;
}): boolean {
  return (
    (item.title === undefined ||
      (typeof item.title === "string" &&
        item.title.length > 0 &&
        item.title.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(item.title))) &&
    (item.description === undefined ||
      (typeof item.description === "string" &&
        item.description.length <= 2000 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.description))) &&
    (item.interruptionReason === undefined ||
      (typeof item.interruptionReason === "string" &&
        interruptionReasons.has(item.interruptionReason)))
  );
}

/** Both metadata and bytes stay behind authorized API reads. Never resolve an
 * arbitrary local:// URL or follow symlinks outside the configured artifact root. */
async function privateFile(filename: string, root: string, limit: number): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(filename);
  if (!canonical.startsWith(`${canonicalRoot}${path.sep}`) || !(await lstat(filename)).isFile())
    throw new Error("native_media_path_invalid");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new Error("native_media_size_invalid");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readNativeEvidenceInventory(options: {
  root: string;
  snapshot: EvidenceStreamSnapshot;
  protection: EvidenceReadProtectionPort;
  /** Authorized application reads may inspect an immutable admitted prefix. */
  allowOpen?: boolean;
  terminal?: boolean;
}): Promise<{ media: NativeMediaReceipt[]; recordingAssessment?: RecordingAssessment }> {
  const { snapshot } = options;
  if (!snapshot.sealedAt && !options.allowOpen) throw new Error("native_media_not_sealed");
  if (snapshot.custodyMode !== "admitted") return { media: [] };
  // A sealed database snapshot is immutable. No live-owner lease or file-system
  // manifest can grant read authority or introduce another receipt.
  const verified = await new AdmittedEvidenceReader<Record<string, unknown>>({
    directory: path.join(options.root, "evidence"),
    runId: snapshot.runId,
    scopeId: snapshot.sessionId,
    protection: options.protection,
    admission: { readStream: async () => snapshot, assertActive() {} },
  }).verify();
  return nativeEvidenceInventory(verified, snapshot, options.terminal);
}

/** Compatibility wrapper; both metadata and assessment share the same verifier. */
export async function readNativeEvidence(
  options: Parameters<typeof readNativeEvidenceInventory>[0],
): Promise<NativeMediaReceipt[]> {
  return (await readNativeEvidenceInventory(options)).media;
}

export function nativeEvidenceInventory(
  verified: EvidenceVerification<Record<string, unknown>>,
  snapshot: EvidenceStreamSnapshot,
  terminal = false,
): { media: NativeMediaReceipt[]; recordingAssessment?: RecordingAssessment } {
  const facts = {
    ownerGenerations: verified.eventOwnerGenerations,
    captureStopped: !!snapshot.captureStoppedAt,
    terminal: terminal || !!snapshot.sealedAt,
    interrupted: snapshot.interruptions > 0,
    writerGeneration: snapshot.writerGeneration,
  };
  const captures = evaluateNativeCaptures(verified.events, facts);
  const events = verified.events.filter((e) => {
    if (e.type !== "native_media") return true;
    const linked = captures.filter((c) => {
      const id = c.reservation.epoch?.captureId;
      return (
        typeof id === "string" &&
        (id === (e.captureEpoch as NativeCaptureEpoch | undefined)?.captureId ||
          (typeof (e.media as Record<string, unknown> | undefined)?.objectKey === "string" &&
            String((e.media as Record<string, unknown>).objectKey).endsWith(
              `/${id}.${c.reservation.kind === "display" ? "mp4" : "webm"}`,
            )))
      );
    });
    if (e.captureEpoch && !linked.length) return false;
    return (
      !linked.length ||
      linked.every((c) => c.assessment.state === "best_effort_assessed" && c.admitted)
    );
  });
  const assessment = recordingAssessment(verified.events, facts);
  return {
    media: nativeMediaReceipts(events),
    ...(assessment ? { recordingAssessment: assessment } : {}),
  };
}

export function nativeMediaReceipts(events: Array<Record<string, unknown>>): NativeMediaReceipt[] {
  const media = events
    .filter((event) => event.type === "native_media")
    .map((event) => event.media as unknown as NativeMediaReceipt);
  for (const item of media) {
    if (
      !/^(?:video|screenshot)$/u.test(item.kind) ||
      !/^native\/\d+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:webm|mp4|png|jpeg|webp)$/u.test(
        item.objectKey,
      ) ||
      !/^[a-f0-9]{64}$/u.test(item.digest) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      !validPresentation(item)
    )
      throw new Error("native_media_manifest_invalid");
    if (
      item.timingOrigin !== undefined &&
      !["native_capture", "recorder_start"].includes(item.timingOrigin)
    )
      throw new Error("native_media_manifest_invalid");
    if (
      item.maskingDiagnostics !== undefined &&
      !maskingDiagnosticsSchema.safeParse(item.maskingDiagnostics).success
    )
      throw new Error("native_media_manifest_invalid");
  }
  return media;
}

export async function readNativeMedia(
  sessionRoot: string,
  receipt: NativeMediaReceipt,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await privateFile(
      path.join(sessionRoot, receipt.objectKey),
      sessionRoot,
      128 * 1024 * 1024,
    );
  } catch (error) {
    if (isArtifactFilesystemFailure(error)) throw new EvidenceArtifactFailure("object_unavailable");
    if (
      error instanceof Error &&
      ["native_media_path_invalid", "native_media_size_invalid"].includes(error.message)
    )
      throw new EvidenceArtifactFailure("content_unverifiable");
    throw error;
  }
  if (bytes.length !== receipt.bytes || hash(bytes) !== receipt.digest)
    throw new EvidenceArtifactFailure("integrity_mismatch");
  return bytes;
}

/** Recover only an authenticated, pre-capture reservation. Never scan orphan
 * directories. Final bytes are copied and admitted under the current owner. */
async function recoverLegacyCaptures(
  root: string,
  events: Record<string, unknown>[],
  native: ChronicleNativeRecordingPort,
  internal: NativeInternal,
): Promise<number> {
  // A receipt admitted before a crash is already authoritative. Do not create
  // another copy merely because its pre-capture reservation remains in history.
  if (nativeMediaReceipts(events).some((item) => item.kind === "video")) return 1;
  internal.restoreLegacyDiagnostics(events);
  const captures = events.filter((e) => e.type === "native_capture_started");
  let recovered = 0;
  for (const capture of captures) {
    const directory = capture.directory;
    if (typeof directory !== "string" || !/^native\/\d+\/[a-f0-9-]{36}\/capture$/u.test(directory))
      throw new Error("native_media_path_invalid");
    let manifest: {
      coverage?: string;
      started?: number;
      duration?: string;
      reason?: string;
      timingOrigin?: string;
    };
    try {
      manifest = JSON.parse(
        (await privateFile(path.join(root, directory, "recording.json"), root, 8192)).toString(
          "utf8",
        ),
      );
    } catch (error) {
      if (isArtifactFilesystemFailure(error)) continue;
      throw error;
    }
    if (
      !["complete", "partial"].includes(manifest.coverage ?? "") ||
      !Number.isSafeInteger(manifest.started)
    )
      continue;
    const bytes = await privateFile(
      path.join(root, directory, "recording.mp4"),
      root,
      128 * 1024 * 1024,
    );
    const filename = `${randomUUID()}.mp4`;
    await durableWrite(path.join(native.directory, filename), bytes);
    await internal.admit({
      filename,
      kind: "video",
      timestamp: manifest.started!,
      label: "final",
      durationMs: Number(manifest.duration) * 1000,
      ...(["native_capture", "recorder_start"].includes(manifest.timingOrigin ?? "")
        ? { timingOrigin: manifest.timingOrigin as "native_capture" | "recorder_start" }
        : {}),
      coverage: manifest.coverage as "complete" | "partial",
      ...(manifest.coverage === "partial"
        ? {
            interruptionReason: interruptionReasons.has(manifest.reason ?? "")
              ? manifest.reason
              : "unknown",
          }
        : {}),
    });
    recovered++;
  }
  return recovered;
}

/** Reservation-aware recovery is the only native video admission capability. */
async function recoverNativeCapturesUnlocked(
  root: string,
  native: ChronicleNativeRecordingPort,
): Promise<NativeCaptureRecovery> {
  const internal = internals.get(native);
  if (!internal) throw new Error("native_capture_recording_invalid");
  internal.assertActive();
  await internal.joinCaptures();
  let verified = await internal.verify();
  const evaluated = evaluateNativeCaptures(verified.events, {
    ownerGenerations: verified.eventOwnerGenerations,
  });
  let admitted = 0;
  // Historical legacy receipts remain authoritative, but never suppress v2 checks.
  const legacyEvents = verified.events.filter((e) => e.type !== "native_media" || !e.captureEpoch);
  if (
    legacyEvents.some((e) => e.type === "native_capture_started") ||
    nativeMediaReceipts(legacyEvents).some((m) => m.kind === "video")
  )
    admitted += await recoverLegacyCaptures(root, legacyEvents, native, internal);
  for (const capture of evaluated) {
    if (capture.admitted) {
      admitted++;
      continue;
    }
    if (
      capture.assessment.state !== "best_effort_assessed" ||
      !capture.physical ||
      !capture.sealDigest
    )
      continue;
    const { reservation, physical } = capture;
    let bytes: Buffer;
    try {
      bytes = await captureFile(path.join(root, reservation.directory, reservation.filename), root);
      if (bytes.length !== physical.bytes || hash(bytes) !== physical.bytesDigest) {
        await internal.append({
          type: "native_capture_admission_failed_v2",
          epoch: reservation.epoch,
          reason: "native_capture_bytes_mismatch",
        });
        continue;
      }
    } catch (error) {
      if (
        !isArtifactFilesystemFailure(error) &&
        !(error instanceof Error && /^native_media_(path|size)_invalid$/.test(error.message))
      )
        throw error;
      await internal.append({
        type: "native_capture_admission_failed_v2",
        epoch: reservation.epoch,
        reason: "native_capture_physical_receipt_missing",
      });
      continue;
    }
    const filename = `${reservation.epoch.captureId}.${reservation.kind === "display" ? "mp4" : "webm"}`;
    internal.assertActive();
    try {
      await durableWrite(path.join(native.directory, filename), bytes);
      await internal.admit(
        {
          filename,
          kind: "video",
          timestamp: physical.started,
          label: "final",
          durationMs: physical.ended - physical.started,
          coverage: physical.physicalCoverage,
          masking: "best_effort",
          timingOrigin: "native_capture",
        },
        {
          epoch: reservation.epoch,
          sealDigest: capture.sealDigest,
          bytesDigest: physical.bytesDigest,
          bytes: physical.bytes,
        },
      );
      admitted++;
    } catch (error) {
      internal.assertActive();
      if (
        !isArtifactFilesystemFailure(error) &&
        !(
          error instanceof Error &&
          /^(?:native_media_(?:admission_failed|capacity_exceeded|path_invalid|size_invalid)|native_capture_bytes_mismatch)$/.test(
            error.message,
          )
        )
      )
        throw error;
      await internal.append({
        type: "native_capture_admission_failed_v2",
        epoch: reservation.epoch,
        reason: "native_capture_admission_unavailable",
      });
    }
  }
  verified = await internal.verify();
  const assessment = recordingAssessment(verified.events, {
    ownerGenerations: verified.eventOwnerGenerations,
  });
  return { admitted, ...(assessment ? { recordingAssessment: assessment } : {}) };
}

const recoveryQueues = new WeakMap<ChronicleNativeRecordingPort, Promise<unknown>>();
export function recoverNativeCaptures(
  root: string,
  native: ChronicleNativeRecordingPort,
): Promise<NativeCaptureRecovery> {
  const next = (recoveryQueues.get(native) ?? Promise.resolve()).then(() =>
    recoverNativeCapturesUnlocked(root, native),
  );
  recoveryQueues.set(
    native,
    next.catch(() => {}),
  );
  return next;
}

async function captureFile(filename: string, root: string): Promise<Buffer> {
  const canonicalRoot = await realpath(root),
    canonical = await realpath(filename);
  if (
    canonical !== path.join(canonicalRoot, path.relative(root, filename)) ||
    (await lstat(filename)).nlink !== 1
  )
    throw new Error("native_media_path_invalid");
  return privateFile(filename, root, 128 * 1024 * 1024);
}
