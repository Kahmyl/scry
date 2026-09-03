import type {
  EngineeringAgentAdapter,
  EngineeringAgentAttempt,
  EngineeringAgentPlan,
  EngineeringAgentRequest,
  EngineeringLabAdapterDescriptor,
} from "./types.js";

export function createDeterministicEngineeringAgentAdapter(input: {
  id: string;
  version?: string;
  attempts: readonly EngineeringAgentAttempt[];
}): EngineeringAgentAdapter {
  if (input.attempts.length === 0) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_FAKE_ATTEMPTS_REQUIRED");
  }

  const identifiers = input.attempts.map(({ id }) => id);

  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("ASSURANCE_ENGINEERING_LAB_FAKE_ATTEMPT_ID_DUPLICATE");
  }

  const descriptor: EngineeringLabAdapterDescriptor = Object.freeze({
    id: input.id,
    kind: "deterministic_fake",
    provider: "assurance",
    version: input.version ?? "1",
  });
  const attempts = Object.freeze(
    input.attempts.map((attempt) =>
      Object.freeze({
        ...attempt,
      }),
    ),
  );

  return Object.freeze({
    descriptor,
    async propose(request: EngineeringAgentRequest): Promise<EngineeringAgentPlan> {
      if (!request.workspaceRoot || !request.reproductionArtifactRef) {
        throw new Error("ASSURANCE_ENGINEERING_LAB_AGENT_REQUEST_INVALID");
      }

      return {
        attempts,
        durationMs: 0,
        cost: {
          currency: "USD",
          amount: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    },
  });
}
