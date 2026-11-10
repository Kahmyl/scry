import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat, unlink, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import type { NativeMediaReceipt } from "@scry/contracts";
import { EvidenceArtifactFailure } from "./evidence-artifact-failure.js";
import { ensurePrivateDirectory } from "./durable-file.js";

export function mediaByteRange(size: number, range?: string, ifRange?: string, etag?: string) {
  if (!range || (ifRange && ifRange !== etag))
    return { status: 200, start: 0, end: size - 1, length: size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return { status: 416, start: 0, end: 0, length: 0 };
  const first = match[1] ? Number(match[1]) : undefined,
    last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return { status: 416, start: 0, end: 0, length: 0 };
  const start = first ?? Math.max(0, size - (last ?? 0)),
    end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || end < start || (last === 0 && first === undefined))
    return { status: 416, start: 0, end: 0, length: 0 };
  return { status: 206, start, end, length: end - start + 1 };
}
let readers = 0;
/** Authenticate metadata first, copy/hash with bounded memory, then expose only
 * a private verified snapshot. Mutation of the original cannot race playback.
 * The scratch copy is never admitted as new evidence and is removed on close. */
export async function streamNativeMedia(
  root: string,
  receipt: NativeMediaReceipt,
  range: { start: number; end: number },
  signal?: AbortSignal,
) {
  if (readers >= 4) throw new Error("native_media_read_capacity");
  readers++;
  let source: Awaited<ReturnType<typeof open>> | undefined,
    snapshot: Awaited<ReturnType<typeof open>> | undefined,
    dir: string | undefined,
    cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    readers--;
    await source?.close().catch(() => {});
    await snapshot?.close().catch(() => {});
    if (dir) {
      await unlink(path.join(dir, "snapshot")).catch(() => {});
      await rmdir(dir).catch(() => {});
    }
  };
  try {
    const canonicalRoot = await realpath(root),
      filename = path.join(root, receipt.objectKey),
      canonical = await realpath(filename);
    if (!canonical.startsWith(canonicalRoot + path.sep) || !(await lstat(filename)).isFile())
      throw new EvidenceArtifactFailure("content_unverifiable");
    source = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.size !== receipt.bytes ||
      before.size < 1 ||
      before.size > 128 * 1024 * 1024
    )
      throw new EvidenceArtifactFailure("integrity_mismatch");
    const staging = path.join(root, "read-staging");
    await ensurePrivateDirectory(staging);
    dir = path.join(staging, randomUUID());
    await mkdir(dir, { mode: 0o700 });
    snapshot = await open(path.join(dir, "snapshot"), "wx+", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of source.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      if (signal?.aborted) throw Error("native_media_read_aborted");
      bytes += chunk.length;
      if (bytes > receipt.bytes) throw new EvidenceArtifactFailure("integrity_mismatch");
      hash.update(chunk);
      await snapshot.writeFile(chunk);
    }
    if (bytes !== receipt.bytes || hash.digest("hex") !== receipt.digest)
      throw new EvidenceArtifactFailure("integrity_mismatch");
    await source.close();
    source = undefined;
    if (signal?.aborted) throw Error("native_media_read_aborted");
    await snapshot.chmod(0o400);
    const stream = snapshot.createReadStream({
      start: range.start,
      end: range.end,
      highWaterMark: 65536,
      autoClose: false,
    });
    // A grant can expire while the asynchronous private unlink below is still
    // pending, before the HTTP consumer attaches its error handler. Keep that
    // abort from becoming an uncaught process error; consumer listeners still
    // receive the same failure and close still releases the private snapshot.
    stream.on("error", () => {});
    const abort = () => stream.destroy(Error("native_media_read_aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => {
      signal?.removeEventListener("abort", abort);
      void cleanup();
    });
    stream.once("end", () => stream.destroy());
    // Unix unlinks the snapshot name while its verified descriptor remains
    // private. Platforms that retain open names remove it in cleanup instead.
    await unlink(path.join(dir, "snapshot")).catch(() => {});
    return stream;
  } catch (error) {
    await cleanup();
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new EvidenceArtifactFailure("object_unavailable");
    throw error;
  }
}
