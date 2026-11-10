import type { FastifyRequest, FastifyReply } from "fastify";
import type { NativeMediaReceipt } from "@scry/contracts";
import { mediaByteRange, streamNativeMedia } from "@scry/chronicle";
import { ServiceUnavailableException } from "@nestjs/common";

/** Scope/retention is resolved by the caller on EVERY request. This shared
 * response path does not authorize a Run or mint a public artifact URL. */
export async function sendNativeVideo(
  media: { root: string; receipt: NativeMediaReceipt; type: string },
  request: FastifyRequest,
  reply: FastifyReply,
  expiresAt?: Date,
) {
  reply
    .header("Cache-Control", "private, no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff");
  const etag = `"${media.receipt.digest}"`,
    range = mediaByteRange(
      media.receipt.bytes,
      request.headers.range,
      request.headers["if-range"] as string | undefined,
      etag,
    );
  reply
    .code(range.status)
    .header("Accept-Ranges", "bytes")
    .header("ETag", etag)
    .header("Content-Type", media.type)
    .header("Content-Disposition", "inline");
  if (range.status === 416)
    return reply.header("Content-Range", `bytes */${media.receipt.bytes}`).send();
  if (range.status === 206)
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${media.receipt.bytes}`);
  reply.header("Content-Length", range.length);
  if (request.method === "HEAD") {
    reply.hijack();
    reply.raw.writeHead(
      range.status,
      Object.fromEntries(
        Object.entries(reply.getHeaders())
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v : String(v)]),
      ),
    );
    reply.raw.end();
    return reply;
  }
  const abort = new AbortController(),
    timer = expiresAt
      ? setTimeout(() => abort.abort(), Math.max(1, new Date(expiresAt).getTime() - Date.now()))
      : undefined;
  const onAbort = () => abort.abort();
  request.raw.once("aborted", onAbort);
  try {
    const stream = await streamNativeMedia(media.root, media.receipt, range, abort.signal);
    stream.once("close", () => {
      clearTimeout(timer);
      request.raw.off("aborted", onAbort);
    });
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) stream.destroy();
    });
    return reply.send(stream);
  } catch (error) {
    clearTimeout(timer);
    request.raw.off("aborted", onAbort);
    reply.removeHeader("Content-Length");
    reply.removeHeader("Content-Range");
    if (error instanceof Error && error.message === "native_media_read_capacity")
      throw new ServiceUnavailableException(
        "Recording readers are busy. Select the recording again shortly.",
      );
    throw error;
  }
}
