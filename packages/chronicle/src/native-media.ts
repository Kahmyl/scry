import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ChronicleNativeRecordingPort, NativeMediaReceipt } from "@scry/contracts";
import type { ChronicleRecording } from "./recording.js";
import { ensurePrivateDirectory } from "./durable-file.js";

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
    maskingUnavailable() {
      maskingUnavailable = true;
    },
    async admit(input) {
      options.assertActive();
      options.recording.assertActive();
      if (
        !/^[a-f0-9-]{36}\.(?:webm|png)$/u.test(input.filename) ||
        !Number.isSafeInteger(input.timestamp) ||
        !["initial", "navigate", "fill", "click", "press", "commit", "final", "page"].includes(
          input.label,
        ) ||
        (input.kind === "video"
          ? !input.filename.endsWith(".webm")
          : !input.filename.endsWith(".png")) ||
        (input.durationMs !== undefined &&
          (!Number.isFinite(input.durationMs) || input.durationMs < 0))
      )
        throw new Error("native_media_receipt_invalid");
      if (admitted.has(input.filename)) return;
      const file = path.join(directory, input.filename);
      const bytes = await privateFile(file, directory, 128 * 1024 * 1024);
      if (usedBytes + bytes.length > 256 * 1024 * 1024)
        throw new Error("native_media_capacity_exceeded");
      const digest = hash(bytes);
      if (input.kind === "screenshot" && screenshotDigests.has(digest)) return;
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
        masking: maskingUnavailable ? "unavailable" : "best_effort",
        kind: input.kind,
        objectKey: path.relative(options.root, file),
        digest,
        bytes: bytes.length,
        timestamp: input.timestamp,
        label: input.label,
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

export async function readNativePublication(
  objectKey: string,
  artifactRoot: string,
): Promise<NativeMediaReceipt[]> {
  if (!objectKey.startsWith("local://")) throw new Error("native_media_manifest_invalid");
  const bytes = await privateFile(objectKey.slice(8), artifactRoot, 4 * 1024 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8")) as { media?: NativeMediaReceipt[] };
  if (!Array.isArray(manifest.media)) return []; // Historical DOM evidence remains unchanged.
  for (const item of manifest.media) {
    if (
      !/^(?:video|screenshot)$/u.test(item.kind) ||
      !/^native\/\d+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:webm|png)$/u.test(item.objectKey) ||
      !/^[a-f0-9]{64}$/u.test(item.digest) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1
    )
      throw new Error("native_media_manifest_invalid");
  }
  return manifest.media;
}

export async function readNativeMedia(
  sessionRoot: string,
  receipt: NativeMediaReceipt,
): Promise<Buffer> {
  const bytes = await privateFile(
    path.join(sessionRoot, receipt.objectKey),
    sessionRoot,
    128 * 1024 * 1024,
  );
  if (bytes.length !== receipt.bytes || hash(bytes) !== receipt.digest)
    throw new Error("native_media_integrity_mismatch");
  return bytes;
}
