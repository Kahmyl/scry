import {
  createHash,
} from "node:crypto";

export function artifactSha256(
  content: Uint8Array,
): string {
  return createHash("sha256")
    .update(content)
    .digest("hex");
}
