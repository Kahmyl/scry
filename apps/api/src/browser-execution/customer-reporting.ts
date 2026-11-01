import { applicationReportPresentationSchema } from "@scry/contracts";

type Row = Record<string, unknown>;
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
