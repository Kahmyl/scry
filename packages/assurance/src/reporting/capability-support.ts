import type {
  CapabilitySupportAssessment,
  CapabilitySupportStatus,
} from "../support/classification.js";

export interface CapabilitySupportReport {
  capabilities: readonly CapabilitySupportAssessment[];
  counts: Readonly<Record<CapabilitySupportStatus, number>>;
  observedInRealApplications: number;
}

export function buildCapabilitySupportReport(
  input: readonly CapabilitySupportAssessment[],
): CapabilitySupportReport {
  const capabilities = [...input].sort((left, right) =>
    left.capability.localeCompare(right.capability),
  );

  const counts: Record<CapabilitySupportStatus, number> = {
    unproven: 0,
    experimental: 0,
    qualified: 0,
    certified: 0,
  };

  let observedInRealApplications = 0;

  for (const capability of capabilities) {
    counts[capability.status] += 1;

    if (capability.observedInRealApplications) {
      observedInRealApplications += 1;
    }
  }

  return {
    capabilities,
    counts,
    observedInRealApplications,
  };
}
