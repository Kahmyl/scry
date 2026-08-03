import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SecretRedactor } from "@scry/policy";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeTraceArchive } from "../src/trace-sanitizer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sanitizeTraceArchive", () => {
  it("redacts literal and URL-encoded secrets without changing binary resources", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scry-trace-"));
    temporaryDirectories.push(directory);
    const tracePath = path.join(directory, "trace.zip");
    const secret = "client+secret@example.invalid";
    const binary = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x81]);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      tracePath,
      zipSync({
        "trace.trace": new TextEncoder().encode(`filled ${secret}`),
        "trace.network": new TextEncoder().encode(`request=${encodeURIComponent(secret)}`),
        "resources/screenshot.jpeg": binary,
      }),
    );

    const redactor = new SecretRedactor();
    redactor.add(secret);
    await sanitizeTraceArchive(tracePath, redactor);

    const archive = unzipSync(await readFile(tracePath));
    expect(new TextDecoder().decode(archive["trace.trace"])).toBe("filled [REDACTED]");
    expect(new TextDecoder().decode(archive["trace.network"])).toBe("request=[REDACTED]");
    expect(archive["resources/screenshot.jpeg"]).toEqual(binary);
  });
});
