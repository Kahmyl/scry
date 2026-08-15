import {
  aggregateRequiredStatuses,
} from "../core/results.js";

import type {
  AssuranceDescriptor,
} from "../core/types.js";

import {
  type VerificationObservation,
} from "../core/results.js";

import {
  defineVerification,
  notRunVerification,
  runVerification,
  type VerificationCase,
  type VerificationExecution,
} from "../verification/primitives.js";

export interface LiveJourneyStep<TContext>
  extends AssuranceDescriptor {
  intent: string;
  capability?: string;
  required?: boolean;

  execute(
    context: TContext,
  ):
    | Promise<VerificationObservation>
    | VerificationObservation;
}

export interface LiveJourneyDefinition<
  TContext = undefined,
> extends AssuranceDescriptor {
  surface: string;

  steps: readonly LiveJourneyStep<TContext>[];

  /**
   * Mandatory task-level completion oracle.
   *
   * A journey does not pass merely because all low-level
   * operations returned without throwing.
   */
  completion: VerificationCase<TContext>;

  stopOnNonPass?: boolean;
}

export interface LiveJourneyStepResult {
  required: boolean;
  intent: string;
  capability?: string;
  verification: VerificationExecution;
}

export interface LiveJourneyResult
  extends AssuranceDescriptor {
  surface: string;
  status: "pass" | "fail" | "inconclusive";
  steps: readonly LiveJourneyStepResult[];
  completion: VerificationExecution;
}

export function defineLiveJourney<
  TContext = undefined,
>(
  definition: LiveJourneyDefinition<TContext>,
): LiveJourneyDefinition<TContext> {
  return definition;
}

export async function runLiveJourney<TContext>(
  journey: LiveJourneyDefinition<TContext>,
  context: TContext,
): Promise<LiveJourneyResult> {
  const steps: LiveJourneyStepResult[] = [];
  let stopped = false;

  for (const step of journey.steps) {
    const required = step.required !== false;

    const verification = defineVerification<TContext>({
      id: step.id,
      title: step.title,
      claim: step.intent,
      oracle: step.execute,

      ...(step.description
        ? { description: step.description }
        : {}),

      ...(step.tags
        ? { tags: step.tags }
        : {}),
    });

    if (stopped) {
      steps.push({
        required,
        intent: step.intent,

        ...(step.capability
          ? { capability: step.capability }
          : {}),

        verification: notRunVerification(
          verification as VerificationCase<unknown>,
          "JOURNEY_STOPPED",
        ),
      });

      continue;
    }

    const execution = await runVerification(
      verification,
      context,
    );

    steps.push({
      required,
      intent: step.intent,

      ...(step.capability
        ? { capability: step.capability }
        : {}),

      verification: execution,
    });

    if (
      journey.stopOnNonPass !== false &&
      required &&
      execution.status !== "pass"
    ) {
      stopped = true;
    }
  }

  const requiredSteps = steps.filter(
    ({ required }) => required,
  );

  const requiredStepsPassed =
    requiredSteps.length > 0 &&
    requiredSteps.every(
      ({ verification }) =>
        verification.status === "pass",
    );

  const completion = requiredStepsPassed
    ? await runVerification(
        journey.completion,
        context,
      )
    : notRunVerification(
        journey.completion as VerificationCase<unknown>,
        "JOURNEY_STEPS_NOT_QUALIFIED",
      );

  const status = aggregateRequiredStatuses([
    ...requiredSteps.map(
      ({ verification }) =>
        verification.status,
    ),
    completion.status,
  ]);

  return {
    id: journey.id,
    title: journey.title,
    surface: journey.surface,
    status,
    steps,
    completion,

    ...(journey.description
      ? { description: journey.description }
      : {}),

    ...(journey.tags
      ? { tags: journey.tags }
      : {}),
  };
}
