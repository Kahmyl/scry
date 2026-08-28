import { createCausalEnvelope } from "./causal-envelope.js";
import { FailpointController, Q2InjectedFault } from "./failpoints.js";
import { evaluateInvariants } from "../q1/invariants.js";
import { applyReferenceAction, createReferenceState } from "../q1/state.js";
import type { Q2SafeScope, Q2Scenario } from "./types.js";

export const q2SafeScope: Q2SafeScope = Object.freeze({
  projectId: "project-q2",
  missionId: "mission-q2",
  objectiveId: "objective-q2",
  agentSessionId: "agent-q2",
  runId: "run-q2",
  attemptId: "attempt-q2",
  praxisSessionId: "praxis-q2",
  operationId: "operation-q2",
  protectedOperationId: "protected-operation-q2",
  correlationId: "correlation-q2",
});

export function runQ2Scenario(scenario: Q2Scenario) {
  const controller = FailpointController.approvedTestComposition([scenario.failpoint]);
  let fault: Q2InjectedFault | undefined;
  try {
    controller.atBoundary(scenario.failpoint.name, q2SafeScope);
  } catch (cause) {
    if (!(cause instanceof Q2InjectedFault)) throw cause;
    fault = cause;
  }
  if (!fault) throw new Error(`Q2_FAILPOINT_DID_NOT_FIRE:${scenario.id}`);
  let snapshot = createReferenceState();
  for (const action of scenario.actions) snapshot = applyReferenceAction(snapshot, action);
  const invariantResults = evaluateInvariants(snapshot);
  const envelope = createCausalEnvelope(scenario, snapshot, q2SafeScope, fault.ledgerRef);
  return {
    scenario,
    snapshot,
    envelope,
    ledger: controller.ledger(),
    invariantResults,
    violations: invariantResults.filter(({ status }) => status === "fail"),
  };
}
