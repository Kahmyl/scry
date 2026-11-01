import type { ChronicleRecordingDiagnostics } from "@scry/contracts";

export interface DiagnosticFinding {
  code:
    | "recording_error"
    | "recording_owner_closed"
    | "recording_empty"
    | "evidence_incomplete"
    | "evidence_metadata_inconsistent";
  severity: "information" | "warning";
  domain: "recording" | "evidence";
}

/** Read-only interpretation of Chronicle's public diagnostics. Error text is
 * deliberately ignored; a recording failure is not a finding against the app. */
export function diagnoseRecording(
  input: Readonly<ChronicleRecordingDiagnostics>,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  if (input.errors.length)
    findings.push({ code: "recording_error", severity: "warning", domain: "recording" });
  if (input.diagnostics.some((entry) => entry.code === "owner_closed_during_capture"))
    findings.push({ code: "recording_owner_closed", severity: "information", domain: "recording" });
  if (input.receivedEvents === 0)
    findings.push({ code: "recording_empty", severity: "warning", domain: "recording" });
  return findings;
}

/** The accepted summary remains Chronicle's fact. This function cannot complete,
 * repair, delete, or reclassify it, or conclude the tested application is wrong. */
export function diagnoseEvidence(
  input: Readonly<{
    state: string;
    chainHead?: string | null;
    chunkCount: number;
    totalBytes: number;
  }>,
): DiagnosticFinding[] {
  if (input.state !== "complete")
    return [{ code: "evidence_incomplete", severity: "warning", domain: "evidence" }];
  if (
    !input.chainHead ||
    input.chunkCount <= 0 ||
    !Number.isSafeInteger(input.chunkCount) ||
    input.totalBytes <= 0 ||
    !Number.isSafeInteger(input.totalBytes)
  )
    return [{ code: "evidence_metadata_inconsistent", severity: "warning", domain: "evidence" }];
  return [];
}
