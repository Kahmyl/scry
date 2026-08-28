import { createHash } from "node:crypto";

import { stableJson } from "../q0/validator.js";
import type { Q3OracleTruth, Q3ScryView } from "./types.js";

export function q3OracleDigest(truth: Q3OracleTruth): string {
  return createHash("sha256").update(stableJson(truth)).digest("hex");
}

export function compareIndependentTruth(input: {
  oracle: Q3OracleTruth | (Omit<Q3OracleTruth, "source"> & { source: "scry" });
  scry: Q3ScryView;
  expectedGeneration: number;
  expectedMutationRequests: number;
  expectedCreatedResources: number;
  expectedCleanupEffects?: number;
}): { verdict: "PASS" | "FAIL"; reasons: string[] } {
  const reasons: string[] = [];
  if (input.oracle.source !== "independent_fixture_oracle") reasons.push("ORACLE_NOT_INDEPENDENT");
  if (input.oracle.generation !== input.expectedGeneration) reasons.push("ORACLE_SNAPSHOT_STALE");
  if (input.oracle.mutationRequests.length !== input.expectedMutationRequests)
    reasons.push("ORACLE_MUTATION_COUNT_MISMATCH");
  if (input.oracle.resources.length !== input.expectedCreatedResources)
    reasons.push("ORACLE_RESOURCE_COUNT_MISMATCH");
  if (input.oracle.cleanupEffects !== (input.expectedCleanupEffects ?? 0))
    reasons.push("ORACLE_CLEANUP_COUNT_MISMATCH");
  const canonical = input.oracle.resources.find(
    (resource) => resource.id === input.scry.resourceIdentity,
  );
  if (input.scry.resourceIdentity && !canonical) reasons.push("ORACLE_RESOURCE_IDENTITY_MISMATCH");
  if (input.scry.redispatchCount > 0) reasons.push("SCRY_UNKNOWN_REDISPATCH_OBSERVED");
  return { verdict: reasons.length ? "FAIL" : "PASS", reasons };
}
