import { veilPolicySnapshotSchema } from "@scry/contracts";
import { compileDefaultVeilPolicy, veilPolicyDigest } from "@scry/veil";

import type { ExecuteOptions } from "./types.js";

export function resolveVeilPolicyForExecution(
  executionPolicy: ExecuteOptions["policy"],
  snapshot?: import("@scry/contracts").VeilPolicySnapshot,
) {
  if (!snapshot) return compileDefaultVeilPolicy(executionPolicy);
  const parsed = veilPolicySnapshotSchema.parse(snapshot);
  const { digest, ...unsigned } = parsed;
  if (veilPolicyDigest(unsigned) !== digest) throw new Error("VEIL_POLICY_SNAPSHOT_DIGEST_INVALID");
  const compatibility = compileDefaultVeilPolicy(executionPolicy);
  if (parsed.allowedOrigins.some((origin) => !compatibility.allowedOrigins.includes(origin)))
    throw new Error("VEIL_POLICY_SNAPSHOT_ORIGIN_MISMATCH");
  return parsed;
}
