import { describe, expect, it } from "vitest";
import { diagnoseEvidence, diagnoseRecording } from "../src/diagnostics.js";

describe("read-only bounded diagnostics", () => {
  it("ignores raw capture errors and emits no application-defect conclusion", () => {
    const input = {
      receivedEvents: 0,
      errors: [{ code: "private-capture-value", message: "private-error-message" }],
      diagnostics: [{ code: "owner_closed_during_capture" }],
    };
    const before = JSON.stringify(input);
    Object.freeze(input.errors);
    Object.freeze(input.diagnostics);
    Object.freeze(input);
    const findings = diagnoseRecording(input);
    expect(findings.map((entry) => entry.code)).toEqual([
      "recording_error",
      "recording_owner_closed",
      "recording_empty",
    ]);
    expect(JSON.stringify(findings)).not.toContain("private-");
    expect(
      findings.every((entry) => entry.severity === "information" || entry.severity === "warning"),
    ).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not change incomplete or inconsistent evidence into completed facts", () => {
    const incomplete = Object.freeze({
      state: "incomplete",
      chainHead: "private-head",
      chunkCount: 1,
      totalBytes: 10,
    });
    expect(diagnoseEvidence(incomplete)).toEqual([
      { code: "evidence_incomplete", severity: "warning", domain: "evidence" },
    ]);
    expect(incomplete.state).toBe("incomplete");
    expect(diagnoseEvidence({ ...incomplete, state: "complete", chunkCount: 0 })[0]?.code).toBe(
      "evidence_metadata_inconsistent",
    );
    expect(diagnoseEvidence({ ...incomplete, state: "complete" })).toEqual([]);
    expect(diagnoseRecording({ receivedEvents: 1, errors: [], diagnostics: [] })).toEqual([]);
  });
});
