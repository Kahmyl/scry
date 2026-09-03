import {
  milestoneCampaignResultSchema,
  type CampaignCheck,
  type MilestoneCampaignResult,
} from "@scry/contracts";
import { measurementIntegrityFailures } from "./adaptive-campaign-report-verification.js";

export function evaluateRequiredChecks(checks: CampaignCheck[]): "pass" | "fail" {
  return checks.length > 0 && checks.every((check) => check.status === "passed") ? "pass" : "fail";
}

export function finalizeCampaignResult(
  input: Omit<MilestoneCampaignResult, "verdict">,
): MilestoneCampaignResult {
  const measurementFailures = measurementIntegrityFailures(
    input.metrics,
    input.target === "production_shaped",
    input.correlationId,
    input.milestone,
  );
  const requiredChecks = [
    ...input.requiredChecks.filter((check) => check.id !== "measurement-integrity"),
    {
      id: "measurement-integrity",
      description:
        "All required counts, phases, and deployed-component traversals are backed by observed events",
      status: measurementFailures.length ? ("failed" as const) : ("passed" as const),
      ...(measurementFailures.length
        ? {
            reasonCode: "MEASUREMENT_UNAVAILABLE",
            safeDetail: { failures: measurementFailures },
          }
        : {}),
    },
  ];
  return milestoneCampaignResultSchema.parse({
    ...input,
    requiredChecks,
    verdict: evaluateRequiredChecks(requiredChecks),
  });
}

export function assertCampaignPassed(result: MilestoneCampaignResult): void {
  const parsed = milestoneCampaignResultSchema.parse(result);
  if (parsed.verdict !== "pass") {
    const failures = parsed.requiredChecks
      .filter((check) => check.status !== "passed")
      .map((check) => `${check.id}:${check.reasonCode ?? check.status}`)
      .join(",");
    throw new Error(`CAMPAIGN_REQUIRED_CHECK_FAILED:${failures}`);
  }
}
