import type { ExecutionPolicy, VeilPolicyPreferences, VeilPolicySnapshot } from "@scry/contracts";
import { compileDefaultVeilPolicy, compileVeilPolicy } from "@scry/veil";

/** Compile once inside the run-creation transaction. The returned snapshot is stored on the run. */
export function snapshotVeilPolicy(
  executionPolicy: ExecutionPolicy,
  persistedPreferences: VeilPolicyPreferences | null | undefined,
): VeilPolicySnapshot {
  const compatibilityFloor = compileDefaultVeilPolicy(executionPolicy);
  if (!persistedPreferences) return compatibilityFloor;
  return compileVeilPolicy([
    {
      profile: compatibilityFloor.profile,
      allowedOrigins: compatibilityFloor.allowedOrigins,
      controls: compatibilityFloor.controls,
      leaseTtlMs: compatibilityFloor.leaseTtlMs,
    },
    persistedPreferences,
  ]);
}
