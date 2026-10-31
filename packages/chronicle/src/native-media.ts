import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  ChronicleNativeRecordingPort,
  NativeMediaReceipt,
  EvidenceStreamSnapshot,
  EvidenceReadProtectionPort,
} from "@scry/contracts";
import type { ChronicleRecording } from "./recording.js";
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
}): Promise<ChronicleNativeRecordingPort> {
  const directory = path.join(options.root, "native", String(options.generation), randomUUID());
  await ensurePrivateDirectory(directory);
  options.assertActive();
  let usedBytes = 0;
  const admitted = new Set<string>();
  const screenshotDigests = new Set<string>();
  let maskingUnavailable = false;
  return {
    directory,
    async reserveCapture() {
      options.assertActive();
      const captureDirectory = path.join(directory, "capture");
      await ensurePrivateDirectory(captureDirectory);
      options.recording.receive(
        JSON.stringify({
          type: "native_capture_started",
          timestamp: Date.now(),
          directory: path.relative(options.root, captureDirectory),
        }),
      );
      if ((await options.recording.flush()).errors.length)
        throw new Error("native_media_admission_failed");
      return captureDirectory;
    },
    maskingUnavailable() {
      maskingUnavailable = true;
    },
    async admit(input) {
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
        masking: maskingUnavailable ? "unavailable" : (input.masking ?? "best_effort"),
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
      };
      options.assertActive();
      options.recording.receive(
        JSON.stringify({ type: "native_media", timestamp: input.timestamp, media: receipt }),
      );
      const diagnostics = await options.recording.flush();
      options.assertActive();
      if (diagnostics.errors.length) throw new Error("native_media_admission_failed");
      usedBytes += bytes.length;
      admitted.add(input.filename);
      if (input.kind === "screenshot") screenshotDigests.add(digest);
    },
    flush: () => options.recording.flush(),
    abort: () => options.recording.abort(),
    recordError: (code, error) => options.recording.recordError(code, error),
  };
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

export async function readNativeEvidence(options: {
  root: string;
  snapshot: EvidenceStreamSnapshot;
  protection: EvidenceReadProtectionPort;
  /** Authorized application reads may inspect an immutable admitted prefix. */
  allowOpen?: boolean;
}): Promise<NativeMediaReceipt[]> {
  const { snapshot } = options;
  if (!snapshot.sealedAt && !options.allowOpen) throw new Error("native_media_not_sealed");
  if (snapshot.custodyMode !== "admitted") return [];
  // A sealed database snapshot is immutable. No live-owner lease or file-system
  // manifest can grant read authority or introduce another receipt.
  const verified = await new AdmittedEvidenceReader<Record<string, unknown>>({
    directory: path.join(options.root, "evidence"),
    runId: snapshot.runId,
    scopeId: snapshot.sessionId,
    protection: options.protection,
    admission: { readStream: async () => snapshot, assertActive() {} },
  }).verify();
  return nativeMediaReceipts(verified.events);
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
export async function recoverNativeCaptures(
  root: string,
  events: Record<string, unknown>[],
  native: ChronicleNativeRecordingPort,
): Promise<number> {
  // A receipt admitted before a crash is already authoritative. Do not create
  // another copy merely because its pre-capture reservation remains in history.
  if (nativeMediaReceipts(events).some((item) => item.kind === "video")) return 1;
  const captures = events.filter((e) => e.type === "native_capture_started");
  let recovered = 0;
  for (const capture of captures) {
    const directory = capture.directory;
    if (typeof directory !== "string" || !/^native\/\d+\/[a-f0-9-]{36}\/capture$/u.test(directory))
      throw new Error("native_media_path_invalid");
    let manifest: { coverage?: string; started?: number; duration?: string; reason?: string };
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
    await native.admit({
      filename,
      kind: "video",
      timestamp: manifest.started!,
      label: "final",
      durationMs: Number(manifest.duration) * 1000,
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
