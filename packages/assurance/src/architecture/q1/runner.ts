import { applyReferenceAction } from "./state.js";
import { evaluateInvariants, invariantStatement } from "./invariants.js";
import type { Q1Reproduction, Q1Sequence, Q1Snapshot, Q1Violation } from "./types.js";

export function runSequence(sequence: Q1Sequence) {
  let state = sequence.initialState;
  const violations: Q1Violation[] = [];
  const visitedFamilies = new Set<string>();
  const visitedPairs = new Set<string>();
  const depths: number[] = [];
  sequence.actions.forEach((action, actionIndex) => {
    const before = state;
    state = applyReferenceAction(before, action);
    const results = evaluateInvariants(state, before, action);
    for (const result of results) {
      visitedFamilies.add(result.family);
      visitedPairs.add(`${result.invariantId}:${action.type}:${result.status}`);
      if (result.status === "fail")
        violations.push({
          invariantId: result.invariantId,
          actionIndex,
          action,
          before,
          after: state,
          result,
        });
    }
    depths.push(actionIndex + 1);
  });
  return {
    finalState: state,
    violations,
    coverage: {
      visitedFamilies: [...visitedFamilies].sort(),
      transitionPairs: [...visitedPairs].sort(),
      depth: depths.at(-1) ?? 0,
    },
  };
}

export function reduceFailure(sequence: Q1Sequence, invariantId: string): Q1Sequence {
  const fails = (candidate: Q1Sequence) =>
    runSequence(candidate).violations.some((violation) => violation.invariantId === invariantId);
  let actions = [...sequence.actions];
  for (let index = 0; index < actions.length;) {
    const candidate = [...actions.slice(0, index), ...actions.slice(index + 1)];
    if (candidate.length && fails({ ...sequence, actions: candidate })) actions = candidate;
    else index += 1;
  }
  return { ...sequence, actions };
}

export function reproductionFor(input: {
  sequence: Q1Sequence;
  invariantId: string;
  release: string;
  schemaFingerprint: string;
  q0ManifestDigest: string;
}): Q1Reproduction {
  const reduced = reduceFailure(input.sequence, input.invariantId);
  const run = runSequence(reduced);
  const violation = run.violations.find(({ invariantId }) => invariantId === input.invariantId);
  if (!violation) throw new Error(`Q1_REPRODUCTION_NOT_REPRODUCIBLE:${input.invariantId}`);
  return {
    invariantId: input.invariantId,
    seed: reduced.seed,
    release: input.release,
    schemaFingerprint: input.schemaFingerprint,
    q0ManifestDigest: input.q0ManifestDigest,
    initialState: reduced.initialState,
    actions: reduced.actions,
    observedState: violation.after,
    expectedRule: invariantStatement(input.invariantId),
    truthSource: reduced.truthSource ?? "pure_reference",
    observedTruth: {
      mutation: violation.after.operation.mutationTruth,
      functional: violation.after.operation.functionalTruth,
      run: violation.after.run.state,
      objective: violation.after.objective.state,
      evidence: violation.after.truth.evidence,
      runtime: violation.after.truth.runtime,
    },
    boundaryIds: violation.result.boundaryIds,
    responsibleOwners: violation.result.responsibleOwners,
    proofTier: violation.result.proofStatus,
  };
}

export function transitionFingerprint(before: Q1Snapshot, after: Q1Snapshot): string {
  return `${before.operation.mutationTruth}->${after.operation.mutationTruth}|${before.run.state}->${after.run.state}|${before.objective.state}->${after.objective.state}`;
}
