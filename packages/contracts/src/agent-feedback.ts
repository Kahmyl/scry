import { nativeImageReasons } from "./native-privacy.js";

/** Pure assessment of authoritative owner facts. No service calls or persistence.
 * Adapters place these fields inside existing extensible command/context records;
 * never add members to a cached strict top-level tool response.
 */
export type Next =
  | {
      actor: "agent";
      action:
        | "retrieve_existing_command"
        | "inspect_application"
        | "inspect_run_release"
        | "review_completed_mission_and_plan_follow_up"
        | "discover_mission"
        | "discover_environment"
        | "review_recorded_mission"
        | "read_saved_report"
        | "inspect_application_read_only"
        | "refresh_scoped_context"
        | "discover_accessible_scope"
        | "review_protected_input_metadata"
        | "review_mission_evidence";
      tool:
        | "get_command"
        | "browser_snapshot"
        | "get_run_status"
        | "get_mission"
        | "get_report"
        | "list_missions"
        | "list_environments"
        | "list_projects"
        | "get_testing_context"
        | "list_credentials";
    }
  | {
      actor: "agent";
      action:
        | "use_returned_observation"
        | "review_returned_receipt"
        | "continue_with_returned_context"
        | "plan_follow_up_from_returned_facts"
        | "review_returned_scope_candidates"
        | "review_recorded_refusal"
        | "use_supported_individual_tools"
        | "await_capacity_without_replay";
    }
  | {
      actor: "agent";
      action: "prepare_incomplete_stop";
      tool: "finish_incomplete_run";
      requiresConfirmation: true;
    }
  | {
      actor: "agent";
      action: "recover_image_read_only_once";
      tool: "browser_take_screenshot";
    }
  | {
      actor: "operator";
      action: "investigate_service" | "review_access" | "review_execution_scope";
      handoff: "scry_operator";
    }
  | { actor: "none"; action: "none" };

export type FeedbackState =
  | "pending"
  | "action_complete_observation_available"
  | "action_complete_image_withheld"
  | "action_complete_observation_unavailable"
  | "action_complete_command_failed"
  | "not_dispatched"
  | "scope_refresh_required"
  | "reconciliation_required"
  | "budget_exhausted"
  | "protected_input_required"
  | "evidence_unconfirmed"
  | "tool_error"
  | "unknown"
  | "scope_restricted"
  | "follow_up_required"
  | "mission_selection_required"
  | "environment_selection_required"
  | "read_only"
  | "access_unavailable"
  | "capability_unavailable"
  | "individual_tools_available"
  | "ready_snapshot"
  | "release_confirmed"
  | "release_confirmed_recording_withheld"
  | "release_confirmed_recording_unavailable"
  | "release_pending"
  | "capacity_unavailable"
  | "stopping";

export type Feedback = Readonly<{
  version: 1;
  state: FeedbackState;
  summary: string;
  next: Next;
  customerActionRequired: boolean;
  applicationConclusion: "not_determined";
  // A denied destination does not establish why a page failed or what was applied.
  scopeRestrictionObserved: boolean;
}>;

const readCommand: Next = {
  actor: "agent",
  action: "retrieve_existing_command",
  tool: "get_command",
};
const inspect: Next = { actor: "agent", action: "inspect_application", tool: "browser_snapshot" };
const release: Next = { actor: "agent", action: "inspect_run_release", tool: "get_run_status" };
const operator: Next = {
  actor: "operator",
  action: "investigate_service",
  handoff: "scry_operator",
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const is = (value: unknown, choices: readonly string[]): boolean =>
  typeof value === "string" && choices.includes(value);
const requiresCustomerAction = (actor: string): boolean => actor === "customer";

function feedback(state: FeedbackState, summary: string, next: Next, scope = false): Feedback {
  return {
    version: 1,
    state,
    summary,
    next: { ...next },
    // There is deliberately no customer repair in the admitted scenarios.
    // If customer decisions are added, extend Next's discriminated union first.
    customerActionRequired: requiresCustomerAction(next.actor),
    applicationConclusion: "not_determined",
    scopeRestrictionObserved: scope,
  };
}

function unknownCommand(scope: boolean, facts: unknown = {}): Feedback {
  const recovery = record(facts);
  const next: Next =
    recovery.readOnlyInspectionSupported === true
      ? { actor: "agent", action: "inspect_application_read_only", tool: "browser_snapshot" }
      : recovery.finishIncompleteSupported === true
        ? {
            actor: "agent",
            action: "prepare_incomplete_stop",
            tool: "finish_incomplete_run",
            requiresConfirmation: true,
          }
        : recovery.statusInspectionSupported === true
          ? { actor: "agent", action: "inspect_run_release", tool: "get_run_status" }
          : operator;
  return feedback(
    "unknown",
    next.action === "inspect_application_read_only"
      ? "The action outcome is unconfirmed. Inspect saved application state through the supported read-only path; do not repeat the action."
      : next.action === "prepare_incomplete_stop"
        ? "The action outcome is unconfirmed. Prepare the supported incomplete-stop path with required confirmation; do not replay the action."
        : next.action === "inspect_run_release"
          ? "The action outcome is unconfirmed. Read current Run status before choosing a supported inspection or incomplete-stop path; do not replay the action."
          : "The action outcome is unconfirmed and no safe recovery path was established. Preserve the receipt for operator review; do not replay the action.",
    next,
    scope,
  );
}

/** Accept only finite owner facts. Extra strings/IDs/errors are never rendered.
 * `scopeRestrictionObserved` must be set by an admitted denial diagnostic adapter,
 * never by searching an arbitrary provider error string.
 */
function baseCommandFeedback(value: unknown): Feedback {
  const c = record(value),
    r = record(c.result);
  const scope = r.scopeRestrictionObserved === true;
  const state = c.state,
    execution = r.execution;
  const knownExecution = is(execution, ["completed", "tool_error", "unknown", "not_dispatched"]);
  if (!is(state, ["queued", "running", "completed", "failed"]))
    return unknownCommand(scope, c.recovery);
  if (is(state, ["queued", "running"])) {
    // Orchestration and action truth are independent. Dispatch-start, partial
    // sequence and acknowledged-action checkpoints are normal before command
    // finalization. Keep retrieving this command and preserve its raw receipts.
    return feedback(
      "pending",
      "This command is still queued or running. Retrieve its existing result, preserve any action receipts, and do not submit a replacement action.",
      readCommand,
      scope,
    );
  }
  if (execution === "unknown" || !knownExecution) return unknownCommand(scope, c.recovery);
  if (r.receipts !== undefined && !Array.isArray(r.receipts))
    return unknownCommand(scope, c.recovery);
  if (execution === "not_dispatched") {
    const dispatchedPrefix = Array.isArray(r.receipts) && r.receipts.length > 0;
    if (
      r.businessOutcome !== "not_dispatched" ||
      dispatchedPrefix ||
      r.reason === "dispatch_started"
    )
      return unknownCommand(scope, c.recovery);
    return feedback(
      "not_dispatched",
      "This command was refused before dispatch. No application action was admitted; review the recorded refusal before choosing a supported next step. This is not permission to retry or widen access.",
      { actor: "agent", action: "review_recorded_refusal" },
      scope,
    );
  }
  if (
    execution === "completed" &&
    Array.isArray(r.receipts) &&
    r.receipts.some((receipt) => record(receipt).execution !== "completed")
  )
    return unknownCommand(scope, c.recovery);
  if (state === "failed" && execution === "completed") {
    const observed = r.observation === "available";
    const next: Next = observed
      ? { actor: "agent", action: "use_returned_observation" }
      : record(c.recovery).statusInspectionSupported === true
        ? release
        : operator;
    return feedback(
      "action_complete_command_failed",
      observed
        ? "The interaction completed, but the command later failed during follow-up work. Use the retained observation; do not repeat the action or infer application success."
        : next.actor === "agent"
          ? "The interaction completed, but the command later failed and its successor observation is unavailable. Check Run status for a supported recovery; do not repeat the action."
          : "The interaction completed, but the command later failed and its successor observation is unavailable. Preserve the receipt for operator review; do not repeat the action.",
      next,
      scope,
    );
  }
  // Only an admitted restriction on this action takes over recovery. Incidental
  // background/analytics denial stays a separate diagnostic beside action truth.
  if (scope && execution === "tool_error" && r.scopeRestrictionImpact === "action_blocked")
    return feedback(
      "scope_restricted",
      "A destination was restricted by this test's scope. This does not establish an application failure or permission to expand access.",
      { actor: "operator", action: "review_execution_scope", handoff: "scry_operator" },
      true,
    );
  if (
    r.observation !== "available" &&
    (r.observationIssue === "native_protection_capacity" ||
      r.observationIssue === "native_protection_classification_failed")
  ) {
    const supported = record(c.recovery).statusInspectionSupported === true;
    const problem =
      r.observationIssue === "native_protection_capacity"
        ? "this session's protected observation capacity is exhausted"
        : "Scry could not safely process this session's protected text";
    const opening =
      execution === "completed"
        ? "The interaction completed, but"
        : "The browser interaction reported an error, and";
    return feedback(
      execution === "completed" ? "action_complete_observation_unavailable" : "tool_error",
      supported
        ? `${opening} ${problem}. Check Run status and prepare a supported incomplete stop; do not repeat the action or request the same snapshot again.`
        : `${opening} ${problem}. Preserve the receipt for operator review; do not repeat the action or request the same snapshot again.`,
      supported ? release : operator,
      scope,
    );
  }
  if (
    r.observation !== "available" &&
    r.observationIssue === "native_protection_refresh_incomplete"
  ) {
    const opening =
      execution === "completed"
        ? "The interaction completed, but"
        : "The browser interaction reported an error, and";
    return feedback(
      execution === "completed" ? "action_complete_observation_unavailable" : "tool_error",
      `${opening} Scry could not safely return the page text. Try a read-only observation to recover current state; do not repeat the action. If the same limit persists, preserve the test gap and continue independent checks.`,
      inspect,
      scope,
    );
  }
  if (execution === "tool_error")
    return feedback(
      "tool_error",
      "The browser interaction reported an error. Inspect the application before deciding what to do; the error does not prove nothing changed.",
      inspect,
      scope,
    );
  if (r.observation === "available")
    return feedback(
      "action_complete_observation_available",
      "The interaction completed and returned an observation. Verify the requested application outcome from that state.",
      { actor: "agent", action: "use_returned_observation" },
      scope,
    );
  return feedback(
    "action_complete_observation_unavailable",
    "The interaction completed, but its successor observation is unavailable. Inspect the application; do not repeat the action.",
    inspect,
    scope,
  );
}

// Image facts describe this response, not action success, credential authority or
// continuous recording privacy. Only the finite owner pairs affect recovery.
const transientImageReasons = Object.keys(nativeImageReasons).filter(
  (reason) => nativeImageReasons[reason as keyof typeof nativeImageReasons] === "read_only_once",
);
const permanentImageReasons = Object.keys(nativeImageReasons).filter(
  (reason) => nativeImageReasons[reason as keyof typeof nativeImageReasons] === "preserve_gap",
);

function imageGap(value: unknown): { transient: boolean } | undefined {
  const fact = record(value);
  if (Object.keys(fact).length !== 3 || fact.state !== "withheld") return;
  if (is(fact.reason, transientImageReasons) && fact.recovery === "read_only_once")
    return { transient: true };
  if (is(fact.reason, permanentImageReasons) && fact.recovery === "preserve_gap")
    return { transient: false };
}

export function commandFeedback(value: unknown): Feedback {
  const c = record(value),
    r = record(c.result),
    base = baseCommandFeedback(c);
  // Sanitizer readiness may accompany error-only text. The existing worker mints
  // this identity only after a successful guarded snapshot; never infer page
  // provenance merely from observation=available or an image recovery tag.
  const pageSnapshot =
    r.observation === "available" &&
    typeof r.observationId === "string" &&
    r.observationId.length > 0;
  const reusable: Feedback =
    base.state === "tool_error" && pageSnapshot
      ? {
          ...base,
          summary:
            "The browser interaction reported an error. Use the returned page state to check what changed; do not repeat the action.",
          next: { actor: "agent", action: "use_returned_observation" },
        }
      : base;
  const gap = imageGap(r.imageEvidence);
  if (
    !gap ||
    r.observation !== "available" ||
    ![
      "action_complete_observation_available",
      "action_complete_command_failed",
      "tool_error",
    ].includes(base.state)
  )
    return reusable;
  const opening =
    base.state === "action_complete_command_failed"
      ? "The interaction completed, but its command failed during follow-up work."
      : r.execution === "completed"
        ? "The interaction completed."
        : "The browser interaction reported an error.";
  const recovery = record(c.recovery);
  const retry =
    gap.transient &&
    recovery.readOnlyImageToolExposed === true &&
    recovery.readOnlyImageInspectionSupported === true;
  return {
    ...base,
    state:
      base.state === "action_complete_observation_available"
        ? "action_complete_image_withheld"
        : base.state,
    summary:
      opening +
      " Scry withheld an image because protection could not be confirmed. " +
      (pageSnapshot
        ? "The returned page text is available. "
        : "The interaction receipt remains available; this response did not establish a fresh page snapshot. ") +
      (retry
        ? "Use it; request one read-only image only if needed and not already tried. If the same gap persists, preserve it and continue independent checks."
        : gap.transient
          ? "Use it and retain the visual-evidence gap; no supported read-only image recovery was established here."
          : "Use it and retain the visual-evidence gap; repeating an unchanged image request will not resolve an unsupported limit."),
    next: retry
      ? { actor: "agent", action: "recover_image_read_only_once", tool: "browser_take_screenshot" }
      : pageSnapshot
        ? { actor: "agent", action: "use_returned_observation" }
        : ["action_complete_observation_available", "action_complete_command_failed"].includes(
              base.state,
            )
          ? { actor: "agent", action: "review_returned_receipt" }
          : base.next,
  };
}

const capabilityNames = [
  "browser",
  "mailboxRead",
  "protectedNavigation",
  "finalize",
  "release",
  "report",
  "journey",
  "sequence",
  "apiRequests",
  "downloadVerification",
  "viewportControl",
] as const;

/** Existing context facts only. No inferred chat answers, approvals or permissions. */
export function contextFeedback(value: unknown): Feedback {
  const c = record(value),
    selected = record(c.selected),
    mission = record(selected.mission);
  const blocked = Array.isArray(c.blocked) ? c.blocked : [];
  const resume = record(c.resume),
    report = record(resume.reportFacts),
    original = record(resume.originalMissionFacts);
  const finalReportId = mission.finalReportId ?? original.finalReportId;
  if (blocked.includes("workspace_read_only"))
    return feedback(
      "read_only",
      "This connection can read the workspace but cannot start this testing work. An operator must review the required access.",
      { actor: "operator", action: "review_access", handoff: "scry_operator" },
    );
  if (mission.state === "completed")
    return feedback(
      "follow_up_required",
      "This Mission is complete. Review its saved results and plan the authorized follow-up; do not restart the completed Mission.",
      typeof finalReportId === "string" && finalReportId.length > 0 && report.state !== "available"
        ? { actor: "agent", action: "read_saved_report", tool: "get_report" }
        : resume.status === "available"
          ? { actor: "agent", action: "plan_follow_up_from_returned_facts" }
          : {
              actor: "agent",
              action: "review_completed_mission_and_plan_follow_up",
              tool: "get_mission",
            },
    );
  if (blocked.includes("active_mission_selection_required"))
    return feedback(
      "mission_selection_required",
      "An active Mission is needed for this work. Find the matching Mission from the Project's saved work.",
      Array.isArray(c.missions) &&
        c.missions.some((m) => is(record(m).state, ["planning", "running"]))
        ? { actor: "agent", action: "review_returned_scope_candidates" }
        : { actor: "agent", action: "discover_mission", tool: "list_missions" },
    );
  if (blocked.includes("active_environment_selection_required"))
    return feedback(
      "environment_selection_required",
      "An active testing Environment is needed. Find the Environment matching the authorized application scope.",
      Array.isArray(c.environments) && c.environments.some((e) => record(e).state === "active")
        ? { actor: "agent", action: "review_returned_scope_candidates" }
        : { actor: "agent", action: "discover_environment", tool: "list_environments" },
    );
  if (
    blocked.length > 0 &&
    blocked.every((b) => b === "sequence") &&
    record(record(record(c.capabilities).features).browser).available === true
  )
    return feedback(
      "individual_tools_available",
      "Guarded sequences are unavailable. Continue through supported individual browser tools, preserving observation and persistence checks.",
      { actor: "agent", action: "use_supported_individual_tools" },
    );
  if (blocked.some((b) => is(b, capabilityNames)))
    return feedback(
      "capability_unavailable",
      "A required testing capability is unavailable. Dependent checks must wait; an operator can review availability.",
      operator,
    );
  // ready is only a snapshot; unknown blockers or contradictory flags cannot pass.
  if (c.ready === true && Array.isArray(c.blocked) && blocked.length === 0)
    return feedback(
      "ready_snapshot",
      "The requested prerequisites are available in this snapshot. This is not permission or proof of host tool access.",
      { actor: "agent", action: "continue_with_returned_context" },
    );
  return feedback(
    "unknown",
    "Testing readiness could not be established. An operator can review the available context.",
    operator,
  );
}

/** Prefer the authoritative aggregate receipt; never reconstruct physical release
 * from a terminal Run alone. Conflicting supplied facts invalidate the receipt.
 */
function baseReleaseFeedback(value: unknown): Feedback {
  const r = record(value);
  if (r.browserReleased === true) {
    if (
      r.terminal !== true ||
      r.pendingCommands !== 0 ||
      (r.state !== undefined &&
        !is(r.state, ["passed", "failed", "cancelled", "infrastructure_error"])) ||
      (r.browserSessionState !== undefined &&
        !is(r.browserSessionState, ["completed", "failed", "cancelled"])) ||
      (r.ownerReleased !== undefined && r.ownerReleased !== true) ||
      (r.evidenceSealed !== undefined && r.evidenceSealed !== true)
    )
      return feedback(
        "unknown",
        "The release facts disagree. Check this Run's current status before claiming the browser was released.",
        release,
      );
    return feedback(
      "release_confirmed",
      "This Run's browser release is confirmed. This does not establish an application test result.",
      { actor: "none", action: "none" },
    );
  }
  if (r.browserReleased === false)
    return feedback(
      "release_pending",
      "Browser release is not confirmed. Check the current Run status before claiming completion.",
      release,
    );
  return feedback(
    "unknown",
    "Browser release could not be established. Check the current Run status.",
    release,
  );
}

export function releaseFeedback(value: unknown): Feedback {
  const facts = record(value),
    base = baseReleaseFeedback(value);
  if (base.state !== "release_confirmed") return base;
  if (facts.recordingAssessmentAvailability === "unavailable")
    return {
      ...base,
      state: "release_confirmed_recording_unavailable",
      summary:
        "The browser was released. Scry could not retrieve its recording assessment. Use the recorded results and any available evidence, keeping recording availability unconfirmed.",
      next: { actor: "agent", action: "continue_with_returned_context" },
    };
  if (record(facts.recordingAssessment).state !== "withheld") return base;
  return {
    ...base,
    state: "release_confirmed_recording_withheld",
    summary:
      "The browser was released. Recording evidence was withheld because protection could not be confirmed. Preserve the recorded results and any available safe evidence, and report the recording gap.",
    next: { actor: "agent", action: "continue_with_returned_context" },
  };
}

/** Exact admitted codes only. No substring matching, raw error echo or write retry. */
export function errorFeedback(code: unknown, authoritativeFacts: unknown = {}): Feedback {
  const facts = record(authoritativeFacts);
  switch (code) {
    case "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED":
      return unknownCommand(false, facts);
    case "SCRY_BROWSER_COMMAND_STOP_REQUESTED":
      return feedback(
        "stopping",
        "This attempt is stopping. Check its existing status; do not submit another application action.",
        release,
      );
    case "SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED":
      // This exact admission code is emitted before a browser is launched.
      // No live caller currently owns an automatic start-retry budget; do not
      // manufacture one from arbitrary fields or turn this into a write retry.
      return feedback(
        "capacity_unavailable",
        "Browser capacity is in use; this start request launched no browser. Keep its identity and continue independent checks. Resume only the same start when capacity is available; do not replay application actions.",
        { actor: "agent", action: "await_capacity_without_replay" },
      );
    case "SCRY_BROWSER_PROJECT_NOT_FOUND":
      return feedback(
        "scope_refresh_required",
        "The selected Project is not available in this connection. Discover accessible Projects and reuse the authorized task scope; do not ask the customer for internal IDs.",
        { actor: "agent", action: "discover_accessible_scope", tool: "list_projects" },
      );
    case "SCRY_BROWSER_MISSION_NOT_FOUND":
    case "SCRY_BROWSER_ENVIRONMENT_NOT_FOUND":
    case "SCRY_BROWSER_RUN_NOT_FOUND":
      return feedback(
        "scope_refresh_required",
        "The selected testing resource is no longer available in the current scope. Refresh scoped Project context and use existing Mission/Environment facts before choosing the next step.",
        { actor: "agent", action: "refresh_scoped_context", tool: "get_testing_context" },
      );
    case "SCRY_BROWSER_REFERENCE_STALE":
    case "SCRY_BROWSER_OWNER_FENCED":
    case "SCRY_BROWSER_ADAPTER_OBSERVATION_INVALIDATED":
      return feedback(
        "reconciliation_required",
        "Current browser references or ownership are no longer usable. Read Run status before choosing a supported read-only reconciliation path; do not replay an action or assume its outcome.",
        release,
      );
    case "SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED":
    case "SCRY_BROWSER_AUTHENTICATION_BUDGET_EXHAUSTED":
      return feedback(
        "budget_exhausted",
        "This attempt reached its action budget. Preserve the results and prepare the supported incomplete stop with required confirmation; do not raise the budget or replay actions.",
        {
          actor: "agent",
          action: "prepare_incomplete_stop",
          tool: "finish_incomplete_run",
          requiresConfirmation: true,
        },
      );
    case "SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE":
      return feedback(
        "protected_input_required",
        "A protected input is unavailable. Review safe credential metadata and the user's existing applicable choice. Use the protected-input flow if needed; never request plaintext or infer approval from a name.",
        { actor: "agent", action: "review_protected_input_metadata", tool: "list_credentials" },
      );
    case "SCRY_BROWSER_EVIDENCE_INCOMPLETE":
    case "SCRY_BROWSER_FINALIZATION_CLOSE_TIMEOUT":
      return feedback(
        "evidence_unconfirmed",
        "Evidence or browser closure could not be confirmed. Read Run status, retain the testing limitation and use supported recovery; do not promote execution status to an application pass.",
        release,
      );
    case "SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE":
      return feedback(
        "evidence_unconfirmed",
        "Mission evidence remains incomplete. Review the recorded attempts and their limitations before any supported finalization; do not turn missing evidence into a passed check.",
        { actor: "agent", action: "review_mission_evidence", tool: "get_mission" },
      );
    case "SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID":
    case "SCRY_BROWSER_WORKFLOW_DISABLED":
    case "SCRY_BROWSER_DISABLED":
      return feedback(
        "capability_unavailable",
        "The required Scry service is unavailable. An operator must review it before dependent checks continue.",
        operator,
      );
    case "SCRY_BROWSER_JOURNEY_FORBIDDEN":
    case "SCRY_BROWSER_ENVIRONMENT_POLICY_FORBIDDEN":
      return feedback(
        "access_unavailable",
        "The requested testing operation is not permitted. An operator can review the required access.",
        { actor: "operator", action: "review_access", handoff: "scry_operator" },
      );
    default:
      return feedback(
        "unknown",
        "Scry could not establish a supported recovery for this condition. Preserve the results and ask an operator to investigate; do not repeat a write.",
        operator,
      );
  }
}

/** These return only extension fields, never a replacement tool envelope. */
export const commandResultFields = (command: unknown): { interaction: Feedback } => ({
  interaction: commandFeedback(command),
});
export const contextFields = (context: unknown): { interaction: Feedback } => ({
  interaction: contextFeedback(context),
});

/** Admit only copy and finite combinations produced by this module. This is a
 * disclosure/schema check, never authentication of the upstream facts. Arbitrary
 * provider summaries, additional payloads and tool names are not carried through.
 */
export function canonicalFeedback(value: unknown): Feedback | undefined {
  const input = record(value);
  const candidates: Feedback[] = [];
  for (const scopeRestrictionObserved of [false, true]) {
    for (const recovery of [
      {},
      { readOnlyInspectionSupported: true },
      { finishIncompleteSupported: true },
      { statusInspectionSupported: true },
    ])
      candidates.push(
        commandFeedback({
          state: "completed",
          result: { execution: "unknown", scopeRestrictionObserved },
          recovery,
        }),
      );
    for (const state of ["queued", "running"])
      candidates.push(commandFeedback({ state, result: { scopeRestrictionObserved } }));
    candidates.push(
      commandFeedback({
        state: "failed",
        result: {
          execution: "not_dispatched",
          businessOutcome: "not_dispatched",
          scopeRestrictionObserved,
        },
      }),
    );
    for (const observation of ["available", "unavailable"])
      for (const recovery of [{}, { statusInspectionSupported: true }])
        candidates.push(
          commandFeedback({
            state: "failed",
            result: { execution: "completed", observation, scopeRestrictionObserved },
            recovery,
          }),
        );
    for (const execution of ["completed", "tool_error"])
      for (const observation of ["available", "unavailable"])
        candidates.push(
          commandFeedback({
            state: "completed",
            result: { execution, observation, scopeRestrictionObserved },
          }),
        );
    for (const execution of ["completed", "tool_error"])
      for (const observationIssue of [
        "native_protection_capacity",
        "native_protection_classification_failed",
        "native_protection_refresh_incomplete",
      ])
        for (const recovery of [{}, { statusInspectionSupported: true }])
          candidates.push(
            commandFeedback({
              state: "completed",
              result: {
                execution,
                observation: "unavailable",
                observationIssue,
                scopeRestrictionObserved,
              },
              recovery,
            }),
          );
  }
  candidates.push(
    commandFeedback({
      state: "completed",
      result: {
        execution: "tool_error",
        scopeRestrictionObserved: true,
        scopeRestrictionImpact: "action_blocked",
      },
    }),
  );
  // Enumerate finite media projections; never admit arbitrary owner reason/copy.
  for (const scopeRestrictionObserved of [false, true])
    for (const reason of [...transientImageReasons, ...permanentImageReasons])
      for (const [state, execution] of [
        ["completed", "completed"],
        ["completed", "tool_error"],
        ["failed", "completed"],
      ])
        for (const pageSnapshot of [false, true])
          for (const supported of [false, true])
            candidates.push(
              commandFeedback({
                state,
                result: {
                  execution,
                  observation: "available",
                  scopeRestrictionObserved,
                  ...(pageSnapshot ? { observationId: "worker-issued" } : {}),
                  imageEvidence: {
                    state: "withheld",
                    reason,
                    recovery: is(reason, transientImageReasons) ? "read_only_once" : "preserve_gap",
                  },
                },
                recovery: {
                  readOnlyImageToolExposed: true,
                  readOnlyImageInspectionSupported: supported,
                },
              }),
            );
  for (const scopeRestrictionObserved of [false, true])
    candidates.push(
      commandFeedback({
        state: "completed",
        result: {
          execution: "tool_error",
          observation: "available",
          observationId: "worker-issued",
          scopeRestrictionObserved,
        },
      }),
    );
  for (const blocked of [
    [],
    ["workspace_read_only"],
    ["active_mission_selection_required"],
    ["active_environment_selection_required"],
    ["browser"],
    ["unknown"],
  ])
    candidates.push(contextFeedback({ ready: blocked.length === 0, blocked }));
  candidates.push(
    contextFeedback({ selected: { mission: { state: "completed" } } }),
    contextFeedback({ selected: { mission: { state: "completed", finalReportId: "known" } } }),
    contextFeedback({
      selected: { mission: { state: "completed" } },
      resume: { status: "available" },
    }),
    contextFeedback({
      blocked: ["active_mission_selection_required"],
      missions: [{ state: "running" }],
    }),
    contextFeedback({
      blocked: ["active_environment_selection_required"],
      environments: [{ state: "active" }],
    }),
    contextFeedback({
      blocked: ["sequence"],
      capabilities: { features: { browser: { available: true } } },
    }),
  );
  for (const r of [
    {},
    { browserReleased: false },
    { browserReleased: true },
    { browserReleased: true, terminal: true, pendingCommands: 0 },
    {
      browserReleased: true,
      terminal: true,
      pendingCommands: 0,
      recordingAssessment: { state: "withheld" },
    },
    {
      browserReleased: true,
      terminal: true,
      pendingCommands: 0,
      recordingAssessmentAvailability: "unavailable",
    },
  ])
    candidates.push(releaseFeedback(r));
  for (const code of [
    undefined,
    "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED",
    "SCRY_BROWSER_COMMAND_STOP_REQUESTED",
    "SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED",
    "SCRY_BROWSER_CAPACITY_CONFIGURATION_INVALID",
    "SCRY_BROWSER_JOURNEY_FORBIDDEN",
    "SCRY_BROWSER_PROJECT_NOT_FOUND",
    "SCRY_BROWSER_MISSION_NOT_FOUND",
    "SCRY_BROWSER_REFERENCE_STALE",
    "SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED",
    "SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE",
    "SCRY_BROWSER_EVIDENCE_INCOMPLETE",
    "SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE",
  ])
    candidates.push(errorFeedback(code));
  return candidates.find((candidate) => {
    const keys = Object.keys(candidate) as Array<keyof Feedback>;
    if (Object.keys(input).length !== keys.length) return false;
    if (!keys.every((key) => key === "next" || input[key] === candidate[key])) return false;
    const next = record(input.next),
      expected = candidate.next as unknown as Record<string, unknown>;
    return (
      Object.keys(next).length === Object.keys(expected).length &&
      Object.keys(expected).every((key) => next[key] === expected[key])
    );
  });
}
