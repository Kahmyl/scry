import {
  applicationReportPresentationSchema,
  releaseFeedback,
  canonicalRecordingAssessment,
} from "@scry/contracts";

type Row = Record<string, unknown>;
export const isTerminalRunState = (state: unknown): boolean =>
  ["passed", "failed", "cancelled", "infrastructure_error"].includes(String(state));
/** Factual execution/release state, never an application verdict. */
export function runRecoveryStatus(row: Row) {
  const terminal = isTerminalRunState(row.state);
  const browserTerminal = ["completed", "failed", "cancelled"].includes(
    String(row.browserSessionState),
  );
  const activity = Array.isArray(row.activity) ? (row.activity as Row[]) : [];
  const pendingCommands =
    typeof row.pendingCommandCount === "number"
      ? row.pendingCommandCount
      : activity.filter((a) => ["queued", "running"].includes(String(a.state))).length;
  const assessment =
    row.recordingAssessmentAvailability === "unavailable"
      ? undefined
      : canonicalRecordingAssessment(row.recordingAssessment);
  const assessmentUnavailable =
    row.recordingAssessmentAvailability === "unavailable" ||
    (row.recordingAssessment !== undefined && !assessment);
  const status = {
    runId: row.id,
    missionId: row.missionId,
    state: row.state,
    outcome: row.outcomeClassification ?? null,
    terminal,
    browserReleased:
      terminal &&
      browserTerminal &&
      row.ownerReleased === true &&
      row.evidenceSealed === true &&
      pendingCommands === 0,
    stopRequested: row.stopRequestedAt != null,
    ownerGeneration:
      Number.isSafeInteger(Number(row.ownerGeneration)) && Number(row.ownerGeneration) > 0
        ? Number(row.ownerGeneration)
        : null,
    pendingCommands,
    ...(assessment ? { recordingAssessment: assessment } : {}),
    ...(assessmentUnavailable ? { recordingAssessmentAvailability: "unavailable" as const } : {}),
  };
  return { ...status, interaction: releaseFeedback(status) };
}
const pick = (row: Row, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
/** Workflow progress only: an ended attempt is not an application verdict. */
export function customerProgress(value: unknown): string {
  if (
    [
      "passed",
      "failed",
      "infrastructure_error",
      "application_failure",
      "environment_failure",
      "blocked",
      "ended",
    ].includes(String(value))
  )
    return "ended";
  if (value === "cancelled") return "cancelled";
  return [
    "pending",
    "queued",
    "starting",
    "running",
    "active",
    "completed",
    "skipped",
    "paused",
  ].includes(String(value))
    ? String(value)
    : "pending";
}
export function customerReport(row: Row): Row {
  const parsed = applicationReportPresentationSchema.safeParse(record(row.safeReport).presentation);
  return {
    ...pick(row, [
      "id",
      "missionId",
      "projectId",
      "missionTitle",
      "originalInstruction",
      "state",
      "createdAt",
      "finalizedAt",
      "evidenceCoverage",
    ]),
    summary: parsed.success
      ? row.summary
      : "Review the available evidence. This earlier report has no structured application checks.",
    safeReport: {
      presentation: parsed.success
        ? parsed.data
        : {
            verified: [],
            observations: [],
            limitations: [
              "This earlier report has not been classified into application checks. Its original data is retained for operator review; do not infer test results from attempt status.",
            ],
          },
    },
  };
}
export function customerRun(row: Row): Row {
  return {
    ...pick(row, [
      "id",
      "projectId",
      "missionId",
      "objectiveId",
      "flowId",
      "flowName",
      "flowPurpose",
      "environmentName",
      "baseOrigin",
      "createdAt",
      "updatedAt",
      "completedAt",
      "artifactCount",
      "completeEvidenceStreams",
      "ownerGeneration",
    ]),
    state: customerProgress(row.state),
    evidence: Array.isArray(row.evidence)
      ? row.evidence.map((item) => {
          const e = record(item);
          return { ...pick(e, ["id"]), state: e.closureIssue ? "unavailable" : e.state };
        })
      : [],
  };
}
export function customerMission(row: Row): Row {
  const rows = (value: unknown) => (Array.isArray(value) ? value.map(record) : []);
  return {
    ...pick(row, ["id", "projectId", "title", "instruction", "finalReportId"]),
    state: customerProgress(row.state),
    objectives: rows(row.objectives).map((item) => ({
      ...pick(item, ["id", "title", "description"]),
      state: customerProgress(item.state),
    })),
    flows: rows(row.flows).map((item) => pick(item, ["id", "name", "purpose", "state"])),
    runs: rows(row.runs).map((item) => ({
      ...pick(item, ["id", "flowId", "objectiveId"]),
      state: customerProgress(item.state),
    })),
  };
}
