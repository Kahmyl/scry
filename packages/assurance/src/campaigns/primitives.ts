import {
  aggregateRequiredStatuses,
} from "../core/results.js";

import type {
  AssuranceDescriptor,
} from "../core/types.js";

import {
  notRunVerification,
  runVerification,
  type VerificationCase,
  type VerificationExecution,
} from "../verification/primitives.js";

export interface CampaignCase<TContext> {
  verification: VerificationCase<TContext>;

  /**
   * Required cases determine campaign qualification.
   *
   * Observational cases remain visible but do not gate.
   */
  required?: boolean;
}

export interface CampaignDefinition<TContext = undefined>
  extends AssuranceDescriptor {
  cases: readonly CampaignCase<TContext>[];
  stopOnFailure?: boolean;
}

export interface CampaignCaseResult {
  required: boolean;
  verification: VerificationExecution;
}

export interface CampaignResult
  extends AssuranceDescriptor {
  status: "pass" | "fail" | "inconclusive";
  cases: readonly CampaignCaseResult[];
}

export function defineCampaign<TContext = undefined>(
  definition: CampaignDefinition<TContext>,
): CampaignDefinition<TContext> {
  return definition;
}

export async function runCampaign<TContext>(
  campaign: CampaignDefinition<TContext>,
  context: TContext,
): Promise<CampaignResult> {
  const results: CampaignCaseResult[] = [];
  let stopped = false;

  for (const entry of campaign.cases) {
    const required = entry.required !== false;

    if (stopped) {
      results.push({
        required,
        verification: notRunVerification(
          entry.verification as VerificationCase<unknown>,
          "CAMPAIGN_STOPPED_AFTER_FAILURE",
        ),
      });

      continue;
    }

    const verification = await runVerification(
      entry.verification,
      context,
    );

    results.push({
      required,
      verification,
    });

    if (
      campaign.stopOnFailure === true &&
      required &&
      verification.status === "fail"
    ) {
      stopped = true;
    }
  }

  const requiredStatuses = results
    .filter(({ required }) => required)
    .map(({ verification }) => verification.status);

  return {
    id: campaign.id,
    title: campaign.title,

    status: aggregateRequiredStatuses(
      requiredStatuses,
    ),

    cases: results,

    ...(campaign.description
      ? { description: campaign.description }
      : {}),

    ...(campaign.tags
      ? { tags: campaign.tags }
      : {}),
  };
}
