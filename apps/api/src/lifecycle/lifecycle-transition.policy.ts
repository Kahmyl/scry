import type { OutcomeClassification } from "@scry/contracts";

export type RunCompletionState = "passed" | "failed" | "cancelled" | "timed_out";

export type TerminalProtectedBoundary =
  { kind: "not_requested" } | { kind: "proven" } | { kind: "unproven" };

export type SuccessorCheckpointDisposition =
  | { kind: "required" }
  | {
      kind: "forbidden";
      reason: "run_not_successful" | "terminal_protected_operation";
    };

export type CompleteRunLifecycleCommand = {
  kind: "complete_run";
  state: RunCompletionState;
  outcomeClassification: OutcomeClassification;
  terminalProtectedBoundary: TerminalProtectedBoundary;
};

export type CompleteRunLifecycleDecision =
  | {
      accepted: true;
      successorCheckpoint: SuccessorCheckpointDisposition;
    }
  | {
      accepted: false;
      code:
        "RUN_TERMINAL_PROTECTED_COMPLETION_UNPROVEN" | "RUN_TERMINAL_PROTECTED_COMPLETION_INVALID";
    };

export type LifecycleTransitionCommand = CompleteRunLifecycleCommand;

export type LifecycleTransitionDecision = CompleteRunLifecycleDecision;

export function decideLifecycleTransition(
  command: LifecycleTransitionCommand,
): LifecycleTransitionDecision {
  switch (command.kind) {
    case "complete_run":
      return decideRunCompletion(command);
  }
}

function decideRunCompletion(command: CompleteRunLifecycleCommand): CompleteRunLifecycleDecision {
  if (command.terminalProtectedBoundary.kind === "unproven") {
    return {
      accepted: false,
      code: "RUN_TERMINAL_PROTECTED_COMPLETION_UNPROVEN",
    };
  }

  if (command.terminalProtectedBoundary.kind === "proven") {
    if (command.state !== "passed") {
      return {
        accepted: false,
        code: "RUN_TERMINAL_PROTECTED_COMPLETION_INVALID",
      };
    }

    return {
      accepted: true,
      successorCheckpoint: {
        kind: "forbidden",
        reason: "terminal_protected_operation",
      },
    };
  }

  if (command.state === "passed") {
    return {
      accepted: true,
      successorCheckpoint: {
        kind: "required",
      },
    };
  }

  return {
    accepted: true,
    successorCheckpoint: {
      kind: "forbidden",
      reason: "run_not_successful",
    },
  };
}
