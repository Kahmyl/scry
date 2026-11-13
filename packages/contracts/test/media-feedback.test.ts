import assert from "node:assert/strict";
import { test } from "vitest";
import { commandFeedback, canonicalFeedback, releaseFeedback } from "../src/agent-feedback.js";

const reasons = [
  ["native_protection_refresh_incomplete", "read_only_once"],
  ["native_protection_geometry_stale", "read_only_once"],
  ["native_protection_geometry_unsupported", "preserve_gap"],
  ["native_protection_graph_capacity", "preserve_gap"],
  ["native_protection_capacity", "preserve_gap"],
  ["native_protection_classification_failed", "preserve_gap"],
  ["native_protection_attestation_invalid", "preserve_gap"],
] as const;

test("media projections roundtrip finite transport while preserving provenance and action truth", () => {
  for (const [reason, recovery] of reasons)
    for (const [state, execution] of [
      ["completed", "completed"],
      ["completed", "tool_error"],
      ["failed", "completed"],
    ])
      for (const snapshot of [false, true])
        for (const exposed of [false, true])
          for (const supported of [false, true]) {
            const command = {
              state,
              result: {
                execution,
                observation: "available",
                ...(snapshot ? { observationId: "worker-issued" } : {}),
                imageEvidence: { state: "withheld", reason, recovery },
              },
              recovery: {
                readOnlyImageToolExposed: exposed,
                readOnlyImageInspectionSupported: supported,
              },
            };
            const before = structuredClone(command),
              f = commandFeedback(command);
            assert.deepEqual(command, before);
            assert.deepEqual(canonicalFeedback(JSON.parse(JSON.stringify(f))), f);
            assert.equal(f.applicationConclusion, "not_determined");
            assert.equal(f.customerActionRequired, false);
            assert.equal(f.summary.includes("returned page text is available"), snapshot);
            const retry = recovery === "read_only_once" && exposed && supported;
            assert.equal(f.next.action === "recover_image_read_only_once", retry);
            if (!snapshot && !retry)
              assert.equal(
                f.next.action,
                execution === "tool_error" ? "inspect_application" : "review_returned_receipt",
              );
            if (execution === "tool_error")
              assert.ok(!f.summary.startsWith("The interaction completed"));
          }
});

test("error-only sanitizer readiness is not a fresh snapshot; a real successor snapshot avoids reread", () => {
  const command = {
    state: "completed",
    result: { execution: "tool_error", observation: "available" },
  };
  assert.equal(commandFeedback(command).next.action, "inspect_application");
  const f = commandFeedback({
    ...command,
    result: { ...command.result, observationId: "worker-issued" },
  });
  assert.equal(f.state, "tool_error");
  assert.equal(f.next.action, "use_returned_observation");
  assert.deepEqual(canonicalFeedback(f), f);
});

test("media facts cannot take ownership from pending, refusal, scope denial or unknown dispatch", () => {
  for (const [reason, recovery] of reasons) {
    const imageEvidence = { state: "withheld", reason, recovery };
    for (const command of [
      { state: "queued", result: { execution: "completed" } },
      { state: "running", result: { execution: "unknown" } },
      { state: "completed", result: { execution: "unknown" } },
      {
        state: "failed",
        result: { execution: "not_dispatched", businessOutcome: "not_dispatched" },
      },
      {
        state: "completed",
        result: {
          execution: "tool_error",
          scopeRestrictionObserved: true,
          scopeRestrictionImpact: "action_blocked",
        },
      },
    ])
      assert.deepEqual(
        commandFeedback({ ...command, result: { ...command.result, imageEvidence } }),
        commandFeedback(command),
      );
  }
  const ordinary = {
    state: "completed",
    result: { execution: "completed", observation: "available" },
  };
  for (const imageEvidence of [
    { state: "withheld", reason: "PRIVATE_ARBITRARY_REASON", recovery: "read_only_once" },
    {
      state: "withheld",
      reason: "native_protection_geometry_unsupported",
      recovery: "read_only_once",
    },
    { state: "available", assessment: "best_effort_known_candidates" },
  ])
    assert.deepEqual(
      commandFeedback({ ...ordinary, result: { ...ordinary.result, imageEvidence } }),
      commandFeedback(ordinary),
    );
});

test("withheld recording never strands confirmed release or overrides contradictory release facts", () => {
  const released = { terminal: true, pendingCommands: 0, browserReleased: true };
  const f = releaseFeedback({ ...released, recordingAssessment: { state: "withheld" } });
  assert.equal(f.state, "release_confirmed_recording_withheld");
  assert.equal(f.next.action, "continue_with_returned_context");
  assert.deepEqual(canonicalFeedback(f), f);
  for (const facts of [
    { ...released, terminal: false },
    { ...released, pendingCommands: 1 },
    { ...released, ownerReleased: false },
    { ...released, browserReleased: false },
  ])
    assert.deepEqual(
      releaseFeedback({ ...facts, recordingAssessment: { state: "withheld" } }),
      releaseFeedback(facts),
    );
  assert.equal(canonicalFeedback({ ...f, summary: "PRIVATE_ARBITRARY_REASON" }), undefined);
});

test("an unavailable optional assessment preserves actual release without claiming permanent withholding", () => {
  const released = { terminal: true, pendingCommands: 0, browserReleased: true };
  const f = releaseFeedback({ ...released, recordingAssessmentAvailability: "unavailable" });
  assert.equal(f.state, "release_confirmed_recording_unavailable");
  assert.equal(f.next.action, "continue_with_returned_context");
  assert.match(f.summary, /could not retrieve/i);
  assert.doesNotMatch(f.summary, /was withheld|check.*status|stop.*again/i);
  assert.deepEqual(canonicalFeedback(f), f);
  assert.equal(f.applicationConclusion, "not_determined");
  assert.equal(
    releaseFeedback({ ...released, recordingAssessmentAvailability: "PRIVATE_REASON" }).state,
    "release_confirmed",
  );
  for (const facts of [
    { ...released, browserReleased: false },
    { ...released, terminal: false },
    { ...released, pendingCommands: 1 },
    { ...released, evidenceSealed: false },
  ])
    assert.deepEqual(
      releaseFeedback({ ...facts, recordingAssessmentAvailability: "unavailable" }),
      releaseFeedback(facts),
    );
});
