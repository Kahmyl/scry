import type { MilestoneCampaignResult } from "@scry/contracts";

export const REQUIRED_CAMPAIGN_PHASES = [
  "queue_wait",
  "browser_startup",
  "document_observation",
  "native_resolution",
  "praxis_grounding",
  "interaction_execution",
  "expected_effect_verification",
  "evidence_finalization",
  "artifact_retrieval",
  "compilation",
  "certification",
] as const;

const REQUIRED_PHASES_BY_MILESTONE: Record<
  MilestoneCampaignResult["milestone"],
  readonly (typeof REQUIRED_CAMPAIGN_PHASES)[number][]
> = {
  M0: [
    "queue_wait",
    "browser_startup",
    "document_observation",
    "praxis_grounding",
    "interaction_execution",
    "expected_effect_verification",
    "evidence_finalization",
    "artifact_retrieval",
  ],
  M1: [
    "queue_wait",
    "browser_startup",
    "document_observation",
    "native_resolution",
    "interaction_execution",
    "expected_effect_verification",
    "evidence_finalization",
    "artifact_retrieval",
  ],
  M2: REQUIRED_CAMPAIGN_PHASES,
  M3: REQUIRED_CAMPAIGN_PHASES,
  M4: REQUIRED_CAMPAIGN_PHASES,
  M5: REQUIRED_CAMPAIGN_PHASES,
};

export type CampaignReleaseIdentity = Pick<
  MilestoneCampaignResult,
  "releaseId" | "schemaFingerprint" | "runtimeVersion" | "gitCommit"
>;

export function matchesCampaignRelease(
  result: MilestoneCampaignResult,
  expected: CampaignReleaseIdentity,
): boolean {
  return (
    result.releaseId === expected.releaseId &&
    result.schemaFingerprint === expected.schemaFingerprint &&
    result.runtimeVersion === expected.runtimeVersion &&
    result.gitCommit === expected.gitCommit
  );
}

export function latestPassingCurrentRelease(
  results: readonly MilestoneCampaignResult[],
  expected: CampaignReleaseIdentity,
): MilestoneCampaignResult | undefined {
  return results
    .filter((result) => result.verdict === "pass" && matchesCampaignRelease(result, expected))
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .at(-1);
}

export function assertRequiredMetricPhases(result: MilestoneCampaignResult): void {
  for (const phase of REQUIRED_PHASES_BY_MILESTONE[result.milestone]) {
    const distribution = result.metrics.phases[phase];
    if (!distribution || distribution.count < 1) {
      throw new Error(`${result.milestone}_METRIC_PHASE_REQUIRED:${phase}`);
    }
  }
}

export function measurementIntegrityFailures(
  metrics: MilestoneCampaignResult["metrics"],
  productionShaped: boolean,
  correlationId: string,
  milestone: MilestoneCampaignResult["milestone"],
): string[] {
  const failures: string[] = [];
  const unique = new Set<string>();
  for (const measurement of metrics.measurements) {
    if (measurement.correlationId !== correlationId) {
      failures.push(`CORRELATION_MISMATCH:${measurement.eventId}`);
    }
    const identity = `${measurement.metric}:${measurement.source}:${measurement.eventId}`;
    if (unique.has(identity)) failures.push(`DUPLICATE_EVENT:${identity}`);
    unique.add(identity);
  }

  const countClaims = {
    agentDecisionBoundaries: metrics.agentDecisionBoundaries,
    mcpRequests: metrics.mcpRequests,
    apiRequests: metrics.apiRequests,
    modelClientIdleMs: metrics.modelClientIdleMs,
    bytesReturnedToAgent: metrics.bytesReturnedToAgent,
    unchangedStateReads: metrics.unchangedStateReads,
  };
  for (const [metric, claimed] of Object.entries(countClaims)) {
    const observed = metrics.measurements
      .filter((entry) => entry.metric === metric)
      .reduce((sum, entry) => sum + entry.value, 0);
    if (observed !== claimed) failures.push(`UNPROVEN_COUNT:${metric}`);
  }

  const requiredPhases = REQUIRED_PHASES_BY_MILESTONE[milestone];
  for (const phase of requiredPhases) {
    const claimed = metrics.phases[phase]?.count ?? 0;
    const observed = metrics.measurements.filter(
      (entry) => entry.metric === `phase:${phase}`,
    ).length;
    if (claimed < 1 || observed !== claimed) failures.push(`MISSING_PHASE:${phase}`);
  }

  if (productionShaped) {
    const requiredSourceMetrics = [
      ["mcp_http", ["mcpRequests"]],
      ["api_http", ["apiRequests"]],
      ["queue_event", ["phase:queue_wait"]],
      ["worker_event", ["phase:document_observation"]],
      ["browser_event", ["phase:browser_startup"]],
      ...(requiredPhases.includes("evidence_finalization")
        ? ([
            ["artifact_event", ["phase:evidence_finalization", "phase:artifact_retrieval"]],
          ] as const)
        : []),
    ] as const;
    for (const [source, requiredMetrics] of requiredSourceMetrics) {
      for (const metric of requiredMetrics) {
        if (
          !metrics.measurements.some((entry) => entry.source === source && entry.metric === metric)
        ) {
          failures.push(`MISSING_SOURCE_METRIC:${source}:${metric}`);
        }
      }
    }
  }
  return failures;
}
