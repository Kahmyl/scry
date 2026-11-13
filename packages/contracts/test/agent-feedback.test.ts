import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalFeedback,
  commandFeedback,
  contextFeedback,
  releaseFeedback,
  errorFeedback,
  commandResultFields,
  contextFields,
} from "../src/agent-feedback.js";

// Before receipts recorded from the first passing prototype. Kept as the
// experiment's semantic baseline; revised assertions below must differ from it.
// Red characterization receipt: 18 tests, 12 passed and these 6 review cases failed
// before the implementation revision. Revised action receipts are asserted below.
const beforeReview = Object.freeze({
  ready: { state: "ready_snapshot", next: "review_recorded_mission", tool: "get_mission" },
  sequence: { state: "capability_unavailable", next: "investigate_service", actor: "operator" },
  returnedMission: {
    state: "mission_selection_required",
    next: "discover_mission",
    tool: "list_missions",
  },
  analyticsDenial: { state: "scope_restricted", next: "review_execution_scope", actor: "operator" },
  terminalUnknown: { state: "unknown", next: "retrieve_existing_command", tool: "get_command" },
  capacity: { state: "capacity_unavailable", next: "investigate_service", actor: "operator" },
});

test("review regression: ready and returned completed-Mission facts require no additional reads", () => {
  const ready = contextFeedback({ ready: true, blocked: [] });
  assert.equal(beforeReview.ready.tool, "get_mission");
  assert.equal(ready.next.action, "continue_with_returned_context");
  assert.equal("tool" in ready.next, false);
  const completed = contextFeedback({
    ready: false,
    blocked: ["active_mission_selection_required"],
    selected: { mission: { state: "completed" } },
    resume: { status: "available", reportRefs: ["private"] },
  });
  assert.equal(completed.next.action, "plan_follow_up_from_returned_facts");
  assert.equal("tool" in completed.next, false);
});

test("review regression: missing sequence has a supported individual-tool fallback", () => {
  const f = contextFeedback({
    ready: false,
    blocked: ["sequence"],
    capabilities: { features: { browser: { available: true } } },
  });
  assert.equal(beforeReview.sequence.actor, "operator");
  assert.equal(f.state, "individual_tools_available");
  assert.equal(f.next.action, "use_supported_individual_tools");
  assert.equal(f.next.actor, "agent");
});

test("review regression: use returned selection metadata before listing again", () => {
  for (const [blocked, rows, state] of [
    ["active_mission_selection_required", "missions", "running"],
    ["active_environment_selection_required", "environments", "active"],
  ]) {
    const f = contextFeedback({ ready: false, blocked: [blocked], [rows!]: [{ state }] });
    assert.equal(beforeReview.returnedMission.tool, "list_missions");
    assert.equal(f.next.action, "review_returned_scope_candidates");
    assert.equal("tool" in f.next, false);
  }
});

test("review regression: incidental denial preserves completed action and reusable observation", () => {
  const f = commandFeedback({
    state: "completed",
    result: { execution: "completed", observation: "available", scopeRestrictionObserved: true },
  });
  assert.equal(beforeReview.analyticsDenial.state, "scope_restricted");
  assert.equal(f.state, "action_complete_observation_available");
  assert.equal(f.next.action, "use_returned_observation");
  assert.equal("tool" in f.next, false);
  assert.equal(f.scopeRestrictionObserved, true);
  assert.equal(f.applicationConclusion, "not_determined");
});

test("review regression: complete unknown receipt inspects only through admitted safe recovery", () => {
  assert.equal(beforeReview.terminalUnknown.tool, "get_command");
  const base = { state: "completed", result: { execution: "unknown" } };
  const inspect = commandFeedback({ ...base, recovery: { readOnlyInspectionSupported: true } });
  assert.equal(inspect.next.action, "inspect_application_read_only");
  const stop = commandFeedback({ ...base, recovery: { finishIncompleteSupported: true } });
  assert.equal(stop.next.action, "prepare_incomplete_stop");
  assert.equal(commandFeedback(base).next.actor, "operator");
});

test("protected observation capacity preserves the completed action without a repeated snapshot loop", () => {
  const command = {
    state: "completed",
    result: {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_capacity",
    },
    recovery: { statusInspectionSupported: true },
  };
  const f = commandFeedback(command);
  assert.equal(f.state, "action_complete_observation_unavailable");
  assert.equal(f.next.action, "inspect_run_release");
  assert.match(f.summary, /capacity.*do not repeat/iu);
  assert.equal(f.applicationConclusion, "not_determined");
  assert.equal(commandFeedback({ ...command, recovery: {} }).next.actor, "operator");
  assert.equal(command.result.execution, "completed");
});

test("temporary protected observation limits explain a read-only recovery without replay permission", () => {
  const f = commandFeedback({
    state: "completed",
    result: {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_refresh_incomplete",
    },
  });
  assert.equal(f.next.action, "inspect_application");
  assert.match(f.summary, /safely return.*read-only.*do not repeat/iu);
  assert.equal(f.applicationConclusion, "not_determined");
});

test("persistent native classification failure directs status review without exposing cause or replaying", () => {
  const f = commandFeedback({
    state: "completed",
    result: {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_classification_failed",
    },
    recovery: { statusInspectionSupported: true },
  });
  assert.equal(f.next.action, "inspect_run_release");
  assert.match(f.summary, /could not safely process.*do not repeat/iu);
  assert.equal(f.applicationConclusion, "not_determined");
});

test.each([
  "native_protection_capacity",
  "native_protection_classification_failed",
  "native_protection_refresh_incomplete",
])(
  "privacy recovery remains canonical for completed and errored actions: %s",
  (observationIssue) => {
    for (const execution of ["completed", "tool_error"])
      for (const scopeRestrictionObserved of [false, true])
        for (const recovery of [{}, { statusInspectionSupported: true }]) {
          const f = commandFeedback({
            state: "completed",
            result: {
              execution,
              observation: "unavailable",
              observationIssue,
              scopeRestrictionObserved,
            },
            recovery,
          });
          assert.deepEqual(canonicalFeedback(f), f);
          if (observationIssue === "native_protection_refresh_incomplete")
            assert.match(f.summary, /safely return.*read-only/iu);
          if (
            execution === "tool_error" &&
            observationIssue !== "native_protection_refresh_incomplete"
          ) {
            assert.equal(f.state, "tool_error");
            assert.notEqual(f.next.action, "inspect_application");
            assert.doesNotMatch(f.summary, /interaction completed/iu);
          }
        }
  },
);

test("capacity uses agent-owned waiting without an invented automatic retry budget", () => {
  assert.equal(beforeReview.capacity.actor, "operator");
  const facts = {
    startDispatch: "not_dispatched",
    sameStartRequestAvailable: true,
    startTool: "start_journey",
    attemptsRemaining: 1,
  };
  const f = errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED", facts);
  assert.equal(f.next.action, "await_capacity_without_replay");
  for (const insufficient of [
    {},
    { ...facts, startDispatch: "unknown" },
    { ...facts, sameStartRequestAvailable: false },
    { ...facts, attemptsRemaining: 0 },
    { ...facts, attemptsRemaining: Infinity },
  ]) {
    assert.equal(
      errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED", insufficient).next.action,
      "await_capacity_without_replay",
    );
  }
});

test("fallback cannot hide unavailable browser, other required checks, or unknown host support", () => {
  assert.equal(
    contextFeedback({ ready: false, blocked: ["sequence"] }).state,
    "capability_unavailable",
  );
  assert.equal(
    contextFeedback({
      ready: false,
      blocked: ["sequence", "mailboxRead"],
      capabilities: { features: { browser: { available: true } } },
    }).state,
    "capability_unavailable",
  );
  const f = contextFeedback({
    ready: false,
    blocked: ["sequence"],
    capabilities: { features: { browser: { available: "true" } } },
  });
  assert.equal(f.next.actor, "operator");
});

test("completed Mission uses its returned saved report reference before rereading Mission", () => {
  const f = contextFeedback({
    selected: { mission: { state: "completed", finalReportId: "sensitive-reference" } },
    blocked: ["active_mission_selection_required"],
  });
  assert.deepEqual(f.next, { actor: "agent", action: "read_saved_report", tool: "get_report" });
  assert.equal(JSON.stringify(f).includes("sensitive-reference"), false);
});

test("incidental denial preserves completed action when observation failed and cannot manufacture causation", () => {
  const f = commandFeedback({
    state: "completed",
    result: {
      execution: "completed",
      observation: "unavailable",
      scopeRestrictionObserved: true,
      scopeRestrictionImpact: "action_blocked",
    },
  });
  assert.equal(f.state, "action_complete_observation_unavailable");
  assert.equal(f.scopeRestrictionObserved, true);
  assert.equal(f.next.action, "inspect_application");
});

test("retry requires the exact retained start, bounded integer budget and admitted capacity code", () => {
  const facts = {
    startDispatch: "not_dispatched",
    sameStartRequestAvailable: true,
    startTool: "start_run",
    attemptsRemaining: 2,
  };
  for (const insufficient of [
    { ...facts, startTool: undefined },
    { ...facts, startTool: "browser_click" },
    { ...facts, attemptsRemaining: 0.5 },
    { ...facts, attemptsRemaining: 4 },
    { ...facts, attemptsRemaining: "1" },
  ])
    assert.equal(
      errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED", insufficient).next.action,
      "await_capacity_without_replay",
    );
  assert.equal(errorFeedback("SCRY_BROWSER_UNKNOWN", facts).next.actor, "operator");
  assert.equal(
    errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED", facts).next.action,
    "await_capacity_without_replay",
  );
});

test("queued/running results retrieve the same durable command without replacement", () => {
  for (const state of ["queued", "running"]) {
    const f = commandFeedback({ state });
    assert.equal(f.state, "pending");
    assert.deepEqual(f.next, {
      actor: "agent",
      action: "retrieve_existing_command",
      tool: "get_command",
    });
  }
});

test("completed interaction with failed observation retains completion and forbids inferred business success", () => {
  const f = commandFeedback({
    state: "completed",
    result: {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "sensitive arbitrary error",
    },
  });
  assert.equal(f.state, "action_complete_observation_unavailable");
  assert.equal(f.next.action, "inspect_application");
  assert.equal(f.applicationConclusion, "not_determined");
  assert.match(f.summary, /do not repeat/);
  assert.equal(JSON.stringify(f).includes("sensitive"), false);
});

test("available observation allows reuse but never proves saved application state", () => {
  const f = commandFeedback({
    state: "completed",
    result: { execution: "completed", observation: "available" },
  });
  assert.equal(f.state, "action_complete_observation_available");
  assert.equal(f.next.action, "use_returned_observation");
  assert.equal(f.applicationConclusion, "not_determined");
});

test("malformed terminal receipts and unknown execution preserve uncertainty", () => {
  for (const c of [
    // Earlier prototype tests incorrectly treated live action prefixes and a
    // completed action followed by orchestration failure as contradictions.
    // The engine lifecycle crossproduct below replaces that invalid assumption.
    { state: "completed", result: { execution: "unknown", observation: "available" } },
    { state: "completed", result: { execution: "novel_state" } },
    null,
    [],
    "completed",
  ]) {
    const f = commandFeedback(c);
    assert.equal(f.state, "unknown");
    assert.equal(f.next.actor, "operator");
  }
});

test("IR03: queued/running orchestration retains every normal checkpoint and polls the same command", () => {
  for (const state of ["queued", "running"])
    for (const result of [
      { execution: "unknown", businessOutcome: "unknown", reason: "dispatch_started" },
      {
        execution: "unknown",
        complete: false,
        receipts: [
          { index: 0, execution: "completed" },
          { index: 1, execution: "unknown" },
        ],
      },
      { execution: "completed", businessOutcome: "unverified", observation: "unavailable" },
      { execution: "completed", observation: "available" },
      { execution: "tool_error", observation: "unavailable" },
      { execution: "not_dispatched", businessOutcome: "not_dispatched" },
    ]) {
      const command = { state, result },
        before = structuredClone(command);
      const f = commandFeedback(command);
      assert.equal(f.state, "pending");
      assert.equal(f.next.action, "retrieve_existing_command");
      assert.equal(f.applicationConclusion, "not_determined");
      assert.deepEqual(command, before);
    }
});

test("IR03: failed orchestration cannot erase an acknowledged completed action", () => {
  for (const observation of ["available", "unavailable"]) {
    const f = commandFeedback({
      state: "failed",
      runId: "not echoed",
      result: { execution: "completed", observation },
      recovery: { statusInspectionSupported: true },
    });
    assert.equal(f.state, "action_complete_command_failed");
    assert.equal(
      f.next.action,
      observation === "available" ? "use_returned_observation" : "inspect_run_release",
    );
    assert.match(f.summary, /interaction completed/i);
    assert.equal(f.applicationConclusion, "not_determined");
    assert.equal(JSON.stringify(f).includes("not echoed"), false);
    assert.deepEqual(canonicalFeedback(f), f);
  }
});

test("IR03: mechanically refused predispatch work is neither unknown nor a write retry", () => {
  for (const scopeRestrictionObserved of [false, true]) {
    const f = commandFeedback({
      state: "failed",
      result: {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        scopeRestrictionObserved,
      },
    });
    assert.equal(f.state, "not_dispatched");
    assert.equal(f.next.action, "review_recorded_refusal");
    assert.equal(f.scopeRestrictionObserved, scopeRestrictionObserved);
    assert.equal(f.applicationConclusion, "not_determined");
    assert.deepEqual(canonicalFeedback(f), f);
  }
  assert.equal(
    commandFeedback({
      state: "failed",
      result: { execution: "not_dispatched", businessOutcome: "unknown" },
    }).state,
    "unknown",
  );
  assert.equal(
    commandFeedback({
      state: "failed",
      result: {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        receipts: [{ execution: "completed" }],
      },
    }).state,
    "unknown",
  );
});

test("IR03: malformed or incompatible terminal sequence prefixes cannot prove non-dispatch or full completion", () => {
  assert.equal(
    commandFeedback({
      state: "failed",
      result: {
        execution: "not_dispatched",
        businessOutcome: "not_dispatched",
        receipts: ["malformed"],
      },
    }).state,
    "unknown",
  );
  assert.equal(
    commandFeedback({
      state: "failed",
      result: { execution: "completed", receipts: [{ execution: "unknown" }] },
    }).state,
    "unknown",
  );
});

test("IR04: completed Mission reads its exact report before planning from incomplete report constraints", () => {
  for (const reportState of ["unavailable", "rejected", "partial", "not_provided"]) {
    const f = contextFeedback({
      selected: { mission: { state: "completed", finalReportId: "known-report" } },
      resume: {
        status: "partial",
        originalMissionFacts: { finalReportId: "known-report" },
        reportFacts: { state: reportState },
      },
    });
    assert.deepEqual(f.next, { actor: "agent", action: "read_saved_report", tool: "get_report" });
  }
  const missingTask = contextFeedback({
    selected: { mission: { state: "completed", finalReportId: "known-report" } },
    resume: {
      status: "partial",
      originalMissionFacts: {},
      reportFacts: { state: "available" },
      parts: { objectives: "unavailable" },
    },
  });
  assert.equal(missingTask.next.action, "review_completed_mission_and_plan_follow_up");
  assert.equal("tool" in missingTask.next && missingTask.next.tool, "get_mission");
});

test("scope restriction is not application cause, permission, or proof of no dispatch", () => {
  const f = commandFeedback({
    state: "completed",
    result: {
      execution: "tool_error",
      scopeRestrictionObserved: true,
      scopeRestrictionImpact: "action_blocked",
      origin: "tunnel://private.example:443",
    },
  });
  assert.equal(f.state, "scope_restricted");
  assert.equal(f.scopeRestrictionObserved, true);
  assert.equal(f.applicationConclusion, "not_determined");
  assert.equal(f.next.action, "review_execution_scope");
  assert.equal(JSON.stringify(f).includes("private.example"), false);
  const uncertain = commandFeedback({
    state: "completed",
    result: { execution: "unknown", scopeRestrictionObserved: true },
  });
  assert.equal(uncertain.state, "unknown");
  assert.equal(uncertain.scopeRestrictionObserved, true);
  assert.equal(uncertain.next.actor, "operator");
});

test("tool error does not assert the action was unapplied", () => {
  const f = commandFeedback({ state: "completed", result: { execution: "tool_error" } });
  assert.equal(f.state, "tool_error");
  assert.match(f.summary, /does not prove nothing changed/);
});

test("completed Mission suggests agent-owned follow-up and never asks for IDs", () => {
  const f = contextFeedback({
    ready: false,
    selected: { mission: { state: "completed", id: "private-id" } },
    blocked: ["active_mission_selection_required"],
  });
  assert.equal(f.state, "follow_up_required");
  assert.equal(f.next.actor, "agent");
  assert.equal(f.next.action, "review_completed_mission_and_plan_follow_up");
  assert.equal(f.customerActionRequired, false);
  assert.equal(JSON.stringify(f).includes("private-id"), false);
});

test("prerequisite selection belongs to the agent; permission/capability repairs belong to operator", () => {
  const cases = [
    ["active_mission_selection_required", "mission_selection_required", "agent"],
    ["active_environment_selection_required", "environment_selection_required", "agent"],
    ["workspace_read_only", "read_only", "operator"],
    ["mailboxRead", "capability_unavailable", "operator"],
  ] as const;
  for (const [blocker, state, actor] of cases) {
    const f = contextFeedback({ ready: false, blocked: [blocker] });
    assert.equal(f.state, state);
    assert.equal(f.next.actor, actor);
    assert.equal(f.customerActionRequired, false);
  }
});

test("unknown blockers and contradictory readiness cannot become ready", () => {
  assert.equal(contextFeedback({ ready: true, blocked: ["unknown-secret"] }).state, "unknown");
  assert.equal(contextFeedback({ ready: true }).state, "unknown");
  assert.equal(contextFeedback({ ready: false, blocked: [] }).state, "unknown");
  assert.equal(
    contextFeedback({ ready: true, blocked: ["workspace_read_only"] }).state,
    "read_only",
  );
  assert.equal(contextFeedback({ ready: true, blocked: [] }).state, "ready_snapshot");
});

test("release needs actual authoritative aggregate plus noncontradictory terminal facts", () => {
  assert.equal(releaseFeedback({ terminal: true, pendingCommands: 0 }).state, "unknown");
  assert.equal(
    releaseFeedback({ terminal: true, browserReleased: false, pendingCommands: 0 }).state,
    "release_pending",
  );
  assert.equal(
    releaseFeedback({ terminal: true, browserReleased: true, pendingCommands: 0 }).state,
    "release_confirmed",
  );
  for (const facts of [
    { terminal: false, pendingCommands: 0 },
    { terminal: true, pendingCommands: 1 },
    { terminal: true, pendingCommands: "0" },
    { terminal: true, pendingCommands: 0, ownerReleased: false },
    { terminal: true, pendingCommands: 0, evidenceSealed: false },
    { terminal: true, pendingCommands: 0, state: "running" },
    { terminal: true, pendingCommands: 0, browserSessionState: "active" },
  ])
    assert.equal(releaseFeedback({ browserReleased: true, ...facts }).state, "unknown");
});

test("finite admitted recovery and unknown errors never authorize write replay or echo errors", () => {
  assert.equal(
    errorFeedback("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED").next.actor,
    "operator",
  );
  assert.equal(errorFeedback("SCRY_BROWSER_COMMAND_STOP_REQUESTED").state, "stopping");
  assert.equal(
    errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED").state,
    "capacity_unavailable",
  );
  assert.equal(errorFeedback("SCRY_BROWSER_ENVIRONMENT_POLICY_FORBIDDEN").next.actor, "operator");
  for (const code of [
    "prefix_SCRY_BROWSER_DISABLED",
    "password=secret",
    { code: "SCRY_BROWSER_DISABLED" },
    null,
  ]) {
    const f = errorFeedback(code);
    assert.equal(f.state, "unknown");
    assert.equal(f.next.actor, "operator");
    assert.equal(JSON.stringify(f).includes("password"), false);
    assert.match(f.summary, /do not repeat a write/);
  }
});

test("finite admitted error families preserve supported self-service recovery without guessing mutation truth", () => {
  const cases = [
    ["SCRY_BROWSER_PROJECT_NOT_FOUND", "list_projects"],
    ["SCRY_BROWSER_MISSION_NOT_FOUND", "get_testing_context"],
    ["SCRY_BROWSER_ENVIRONMENT_NOT_FOUND", "get_testing_context"],
    ["SCRY_BROWSER_RUN_NOT_FOUND", "get_testing_context"],
    ["SCRY_BROWSER_REFERENCE_STALE", "get_run_status"],
    ["SCRY_BROWSER_OWNER_FENCED", "get_run_status"],
    ["SCRY_BROWSER_ADAPTER_OBSERVATION_INVALIDATED", "get_run_status"],
    ["SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED", "finish_incomplete_run"],
    ["SCRY_BROWSER_AUTHENTICATION_BUDGET_EXHAUSTED", "finish_incomplete_run"],
    ["SCRY_BROWSER_PROTECTED_INPUT_UNAVAILABLE", "list_credentials"],
    ["SCRY_BROWSER_EVIDENCE_INCOMPLETE", "get_run_status"],
    ["SCRY_BROWSER_FINALIZATION_CLOSE_TIMEOUT", "get_run_status"],
    ["SCRY_BROWSER_MISSION_EVIDENCE_INCOMPLETE", "get_mission"],
  ] as const;
  for (const [code, tool] of cases) {
    const f = errorFeedback(code);
    assert.equal(f.next.actor, "agent");
    assert.equal("tool" in f.next && f.next.tool, tool);
    assert.equal(f.applicationConclusion, "not_determined");
    assert.equal(f.customerActionRequired, false);
    assert.deepEqual(canonicalFeedback(f), f);
    assert.equal(f.summary.includes(code), false);
  }
  const budget = errorFeedback("SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED");
  assert.equal("requiresConfirmation" in budget.next && budget.next.requiresConfirmation, true);
  assert.equal(
    errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED").next.action,
    "await_capacity_without_replay",
  );
  assert.equal(
    errorFeedback("SCRY_BROWSER_BUSINESS_BUDGET_EXHAUSTED_PRIVATE").next.actor,
    "operator",
  );
});

test("extensions stay small, finite, privacy-safe, and outside strict top-level envelopes", () => {
  const samples = [
    commandResultFields({
      state: "completed",
      result: { execution: "completed", observation: "available" },
      id: "secret",
    }),
    commandResultFields({ state: "queued" }),
    contextFields({ ready: true, blocked: [] }),
    contextFields({ blocked: ["browser"], ready: false }),
  ];
  for (const fields of samples) {
    assert.deepEqual(Object.keys(fields), ["interaction"]);
    assert.equal(
      fields.interaction.customerActionRequired,
      fields.interaction.next.actor === ("customer" as string),
    );
    assert.equal(fields.interaction.applicationConclusion, "not_determined");
    assert.ok(Buffer.byteLength(JSON.stringify(fields)) < 700);
    assert.equal(JSON.stringify(fields).includes("secret"), false);
  }
});

test("canonical transport admission rejects arbitrary copy, nested extras and made-up recovery tools", () => {
  const known = commandFeedback({
    state: "completed",
    result: { execution: "unknown" },
    recovery: { statusInspectionSupported: true },
  });
  assert.deepEqual(known.next, {
    actor: "agent",
    action: "inspect_run_release",
    tool: "get_run_status",
  });
  assert.deepEqual(canonicalFeedback(JSON.parse(JSON.stringify(known))), known);
  for (const invalid of [
    { ...known, summary: "PRIVATE_PROVIDER_TOKEN" },
    { ...known, next: { ...known.next, raw: "PRIVATE_PROVIDER_TOKEN" } },
    { ...known, next: { actor: "agent", action: "retry_write", tool: "browser_click" } },
    { ...known, extra: "PRIVATE_PROVIDER_TOKEN" },
    { ...known, version: 2 },
  ])
    assert.equal(canonicalFeedback(invalid), undefined);
  const capacity = errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED", {
    startDispatch: "not_dispatched",
    sameStartRequestAvailable: true,
    startTool: "start_run",
    attemptsRemaining: 2,
  });
  assert.deepEqual(canonicalFeedback(capacity), capacity);
});
