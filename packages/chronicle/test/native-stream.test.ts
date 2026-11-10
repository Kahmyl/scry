import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { mediaByteRange, streamNativeMedia } from "../src/native-stream.js";
import type { NativeMediaReceipt } from "@scry/contracts";
it.each([
  [undefined, 200, 0, 99, 100],
  ["bytes=0-9", 206, 0, 9, 10],
  ["bytes=90-", 206, 90, 99, 10],
  ["bytes=-10", 206, 90, 99, 10],
  ["bytes=0-999", 206, 0, 99, 100],
  ["bytes=-999", 206, 0, 99, 100],
  ["bytes=100-", 416, 0, 0, 0],
  ["bytes=-0", 416, 0, 0, 0],
  ["bytes=10-1", 416, 0, 0, 0],
  ["bytes=", 416, 0, 0, 0],
  ["bytes=0-1,4-5", 416, 0, 0, 0],
  ["bytes=9007199254740992-", 416, 0, 0, 0],
  ["none", 416, 0, 0, 0],
] as const)("single range %s has exact status and bounds", (range, status, start, end, length) =>
  expect(mediaByteRange(100, range)).toEqual({ status, start, end, length }),
);
it("If-Range mismatch returns the full representation", () =>
  expect(mediaByteRange(100, "bytes=0-9", '"old"', '"new"')).toMatchObject({
    status: 200,
    length: 100,
  }));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scry-stream-")),
    key = `native/1/${randomUUID()}/${randomUUID()}.mp4`;
  await mkdir(path.dirname(path.join(root, key)), { recursive: true });
  const bytes = Buffer.from("fictional-verified-recording-".repeat(4096));
  await writeFile(path.join(root, key), bytes, { mode: 0o600 });
  const receipt: NativeMediaReceipt = {
    objectKey: key,
    kind: "video",
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    timestamp: Date.now(),
    label: "final",
  };
  return { root, key, bytes, receipt };
}
async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
async function cleaned(root: string) {
  for (let i = 0; i < 50; i++) {
    if (!(await readdir(path.join(root, "read-staging")).catch(() => [])).length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("scratch remained");
}
it("streams exact verified ranges from an immutable private snapshot with cleanup", async () => {
  const f = await fixture();
  try {
    const stream = await streamNativeMedia(f.root, f.receipt, { start: 3, end: 31 });
    await writeFile(path.join(f.root, f.key), Buffer.alloc(f.bytes.length, 88));
    expect(await collect(stream)).toEqual(f.bytes.subarray(3, 32));
    await cleaned(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("rejects tampering before exposing any bytes", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, f.key), Buffer.alloc(f.bytes.length, 88));
    await expect(streamNativeMedia(f.root, f.receipt, { start: 0, end: 10 })).rejects.toMatchObject(
      { issue: "integrity_mismatch" },
    );
    await cleaned(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("does not follow an outside symlink even with a matching digest", async () => {
  const f = await fixture(),
    outside = path.join(tmpdir(), randomUUID());
  try {
    await writeFile(outside, f.bytes);
    await rm(path.join(f.root, f.key));
    await symlink(outside, path.join(f.root, f.key));
    await expect(streamNativeMedia(f.root, f.receipt, { start: 0, end: 10 })).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
it("abort before delivery leaves no unadmitted copy", async () => {
  const f = await fixture(),
    c = new AbortController();
  c.abort();
  try {
    await expect(
      streamNativeMedia(f.root, f.receipt, { start: 0, end: 10 }, c.signal),
    ).rejects.toThrow();
    await cleaned(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("interrupted playback frees its scratch and can retry the same admitted bytes", async () => {
  const f = await fixture();
  try {
    const stream = await streamNativeMedia(f.root, f.receipt, {
      start: 0,
      end: f.bytes.length - 1,
    });
    stream.destroy();
    await cleaned(f.root);
    const retry = await streamNativeMedia(f.root, f.receipt, { start: 0, end: 63 });
    expect(await collect(retry)).toEqual(f.bytes.subarray(0, 64));
    await cleaned(f.root);
    expect(await readFile(path.join(f.root, f.key))).toEqual(f.bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("an expiring grant can abort before the HTTP consumer attaches without an uncaught error", async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    const stream = await streamNativeMedia(
      f.root,
      f.receipt,
      { start: 0, end: 63 },
      controller.signal,
    );
    controller.abort();
    await cleaned(f.root);
    expect(stream.destroyed).toBe(true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
