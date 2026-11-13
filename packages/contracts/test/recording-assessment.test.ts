import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalRecordingAssessment,
  nativeCaptureWithholdReasons,
} from "../src/native-privacy.js";

test("recording assessment transport carries finite owner facts without extra payloads", () => {
  const raw = "PRIVATE_VALUE_SHOULD_NOT_BE_FORWARDED";
  for (const fact of [
    { state: "pending" },
    { state: "best_effort_assessed", warning: "automatic_redaction_best_effort" },
    ...nativeCaptureWithholdReasons.map((reason) => ({
      state: "withheld",
      reason,
      warning: "automatic_redaction_best_effort",
    })),
  ]) {
    const input = Object.freeze({ ...fact, raw, capture: { private: raw } });
    const output = canonicalRecordingAssessment(input);
    assert.deepEqual(output, fact);
    assert.notEqual(output, input);
    assert.ok(!JSON.stringify(output).includes(raw));
    assert.deepEqual(canonicalRecordingAssessment(JSON.parse(JSON.stringify(output))), output);
  }
});

test("untrusted states, reasons and warning text cannot become an admitted assessment", () => {
  for (const input of [
    undefined,
    null,
    [],
    "withheld",
    { state: "PRIVATE_STATE" },
    { state: "best_effort_assessed", warning: "PRIVATE_PROVIDER_MESSAGE" },
    { state: "withheld", reason: "native_protection_capacity" },
    { state: "withheld", reason: "PRIVATE_REASON", warning: "automatic_redaction_best_effort" },
    {
      state: "withheld",
      reason: { raw: "PRIVATE_VALUE" },
      warning: "automatic_redaction_best_effort",
    },
  ])
    assert.equal(canonicalRecordingAssessment(input), undefined);
});
