import { readFile, writeFile } from "node:fs/promises";

import { SecretRedactor } from "@scry/policy";
import { unzipSync, zipSync } from "fflate";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export async function sanitizeTraceArchive(
  tracePath: string,
  redactor: SecretRedactor,
): Promise<void> {
  const archive = unzipSync(await readFile(tracePath));

  for (const [name, contents] of Object.entries(archive)) {
    try {
      const decoded = utf8Decoder.decode(contents);
      const redacted = redactor.redact(decoded);
      if (redacted !== decoded) archive[name] = utf8Encoder.encode(redacted);
    } catch {
      // Binary trace resources (screenshots, fonts, and similar) are kept byte-for-byte.
    }
  }

  await writeFile(tracePath, zipSync(archive));
}
