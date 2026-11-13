/** Bounded factual projection, not authentication or an approval authority.
 * Caller must supply an already authorized observeMission row and, optionally,
 * its already sanitized customer report. Binding checks cannot replace that owner.
 * All strings/criteria remain untrusted data: render as text, never execute them
 * or interpret them as instructions, permission, credential choice or coverage.
 */
type Row = Record<string, unknown>;
type Part = "available" | "partial" | "unavailable";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Source = {
  kind: "mission" | "objective" | "attempt" | "report";
  id: string;
  projectId: string;
  missionId: string;
  missionRevision: number | null;
};
type Criteria = { value: Json; completeness: "complete" | "truncated" | "unavailable" };
type Objective = {
  source: Source;
  title: string | null;
  description: string | null;
  state: string;
  criteria: Criteria;
  conclusion: string | null;
};
type Attempt = { source: Source; state: string; conclusion: string | null };
type Evidence = { runId: string; artifactId: string };
type Check = {
  title: string;
  actual: string;
  expected?: string;
  status: string;
  evidence?: Evidence[];
};
type Observation = { title: string; detail: string; suggestion?: string; evidence?: Evidence[] };
type Section = {
  title: string;
  items: Array<{ title: string; detail: string; evidence?: Evidence[] }>;
};
type Omission =
  | "checks"
  | "scope"
  | "limitations"
  | "verified"
  | "observations"
  | "sections"
  | "evidence"
  | "summary";
type ReportFacts = {
  state: Part | "rejected" | "not_provided";
  source?: Source;
  checks: Check[];
  summary?: string;
  scope: string[];
  limitations: string[];
  verified: string[];
  observations: Observation[];
  sections: Section[];
  omitted: Record<Omission, boolean>;
};
const emptyReport = (state: ReportFacts["state"]): ReportFacts => ({
  state,
  checks: [],
  scope: [],
  limitations: [],
  verified: [],
  observations: [],
  sections: [],
  omitted: {
    checks: false,
    scope: false,
    limitations: false,
    verified: false,
    observations: false,
    sections: false,
    evidence: false,
    summary: false,
  },
});
export type Resume = {
  version: 1;
  status: Part;
  binding: { projectId: string; missionId: string; revision: number | null } | null;
  textTrust: "untrusted_recorded_data";
  lifecycle: "active" | "completed" | "paused" | "ended" | "unknown";
  alternatives: Array<
    | "continue_recorded_work"
    | "review_saved_results"
    | "plan_separate_follow_up"
    | "review_recorded_state"
  >;
  originalMissionFacts: {
    source: Source;
    state: string;
    instruction: string | null;
    finalReportId: string | null;
    objectives: Objective[];
    attempts: Attempt[];
  } | null;
  reportFacts: ReportFacts;
  parts: { mission: Part; objectives: Part; attempts: Part; report: ReportFacts["state"] };
  truncated: {
    instruction: boolean;
    objectives: boolean;
    attempts: boolean;
    criteria: boolean;
    reportChecks: boolean;
    otherText: boolean;
  };
  decisions: "unknown";
  permissions: "not_determined";
};

const row = (v: unknown): Row =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(v);
const oneOf = (v: unknown, values: readonly string[]): v is string =>
  typeof v === "string" && values.includes(v);
const encoder = new TextEncoder();
function clip(v: string, bytes: number): { text: string; truncated: boolean } {
  let text = "",
    used = 0;
  for (const character of v) {
    const n = encoder.encode(character).length;
    if (used + n > bytes) return { text, truncated: true };
    text += character;
    used += n;
  }
  return { text, truncated: false };
}

function boundedCriteria(input: unknown): Criteria {
  // observeMission's criteria are a JSON object. Missing/malformed roots are
  // unavailable; nested null remains legitimate recorded JSON.
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { value: null, completeness: "unavailable" };
  let remaining = 1024,
    nodes = 0,
    truncated = false;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): Json => {
    if (++nodes > 32 || depth > 3 || remaining <= 0) {
      truncated = true;
      return null;
    }
    if (typeof v === "string") {
      const bounded = clip(v, Math.min(256, remaining));
      remaining -= encoder.encode(bounded.text).length;
      truncated ||= bounded.truncated;
      return bounded.text;
    }
    remaining -= 8;
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object" || seen.has(v)) {
      truncated = true;
      return null;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 8) truncated = true;
      return v.slice(0, 8).map((item) => visit(item, depth + 1));
    }
    const keys = Object.keys(v);
    if (keys.length > 8) truncated = true;
    const result: { [key: string]: Json } = Object.create(null);
    for (const key of keys.slice(0, 8)) {
      const bytes = encoder.encode(key).length;
      if (bytes > 64 || remaining < bytes) {
        truncated = true;
        continue;
      }
      remaining -= bytes;
      result[key] = visit((v as Row)[key], depth + 1);
    }
    return result;
  };
  const value = visit(input, 0);
  return { value, completeness: truncated ? "truncated" : "complete" };
}

/** No new persistence, API calls, latest-report selection or inferred corrections. */
export function projectResume(input: unknown): Resume {
  const request = row(input),
    scope = row(request.scope),
    mission = row(request.mission);
  const output: Resume = {
    version: 1,
    status: "unavailable",
    binding: null,
    textTrust: "untrusted_recorded_data",
    lifecycle: "unknown",
    alternatives: [],
    originalMissionFacts: null,
    reportFacts: emptyReport("unavailable"),
    parts: {
      mission: "unavailable",
      objectives: "unavailable",
      attempts: "unavailable",
      report: "unavailable",
    },
    truncated: {
      instruction: false,
      objectives: false,
      attempts: false,
      criteria: false,
      reportChecks: false,
      otherText: false,
    },
    decisions: "unknown",
    permissions: "not_determined",
  };
  if (
    !uuid(scope.projectId) ||
    !uuid(scope.missionId) ||
    mission.projectId !== scope.projectId ||
    mission.id !== scope.missionId
  )
    return output;
  const projectId = scope.projectId,
    missionId = scope.missionId;
  const revision =
    typeof mission.revision === "number" &&
    Number.isSafeInteger(mission.revision) &&
    mission.revision >= 0
      ? mission.revision
      : null;
  // Child rows may be read under independently bounded metadata transactions;
  // the Mission revision cannot certify their point-in-time version.
  const source = (kind: Source["kind"], id: string): Source => ({
    kind,
    id,
    projectId,
    missionId,
    missionRevision: kind === "mission" ? revision : null,
  });
  output.binding = { projectId, missionId, revision };
  output.parts.mission = revision === null ? "partial" : "available";
  output.lifecycle =
    mission.state === "completed"
      ? "completed"
      : oneOf(mission.state, ["planning", "running"])
        ? "active"
        : oneOf(mission.state, ["blocked", "awaiting_user"])
          ? "paused"
          : oneOf(mission.state, ["failed", "cancelled"])
            ? "ended"
            : "unknown";
  if (output.lifecycle === "unknown") output.parts.mission = "partial";
  output.alternatives =
    output.lifecycle === "completed"
      ? ["review_saved_results", "plan_separate_follow_up"]
      : output.lifecycle === "active"
        ? ["continue_recorded_work"]
        : ["review_recorded_state"];
  const text = (v: unknown, bytes: number, instruction = false): string | null => {
    if (typeof v !== "string") return null;
    const result = clip(v, bytes);
    if (result.truncated) output.truncated[instruction ? "instruction" : "otherText"] = true;
    return result.text;
  };
  const instruction = text(mission.instruction, 1000, true);
  if (instruction === null) output.parts.mission = "partial";
  let finalReportId: string | null = null;
  if (uuid(mission.finalReportId)) finalReportId = mission.finalReportId;
  else if (mission.finalReportId !== null && mission.finalReportId !== undefined)
    output.parts.mission = "partial";
  const facts = {
    source: source("mission", missionId),
    state: output.lifecycle === "unknown" ? "unknown" : String(mission.state),
    instruction,
    finalReportId,
    objectives: [] as Objective[],
    attempts: [] as Attempt[],
  };
  output.originalMissionFacts = facts;

  function children(
    value: unknown,
    part: "objectives" | "attempts",
    limit: number,
    build: (r: Row, id: string) => void,
  ) {
    if (!Array.isArray(value)) {
      output.parts[part] = "unavailable";
      return;
    }
    output.parts[part] = "available";
    if (value.length > limit) {
      output.truncated[part] = true;
      output.parts[part] = "partial";
    }
    const seen = new Set<string>();
    for (const item of value.slice(0, limit)) {
      const r = row(item);
      if (
        !uuid(r.id) ||
        seen.has(r.id) ||
        (r.missionId !== undefined && r.missionId !== missionId) ||
        (r.projectId !== undefined && r.projectId !== projectId)
      ) {
        output.parts[part] = "partial";
        continue;
      }
      seen.add(r.id);
      build(r, r.id);
    }
  }
  children(mission.objectives, "objectives", 4, (r, id) => {
    const criteria = boundedCriteria(r.completionCriteria);
    if (r.completionCriteriaTruncated === true) {
      criteria.completeness = "truncated";
      output.truncated.criteria = true;
    }
    if (criteria.completeness !== "complete") output.parts.objectives = "partial";
    output.truncated.criteria ||= criteria.completeness === "truncated";
    const state = oneOf(r.state, [
      "pending",
      "running",
      "completed",
      "passed",
      "failed",
      "blocked",
      "skipped",
      "cancelled",
    ])
      ? r.state
      : "unknown";
    if (state === "unknown") output.parts.objectives = "partial";
    facts.objectives.push({
      source: source("objective", id),
      title: text(r.title, 120),
      description: text(r.description, 240),
      state,
      criteria,
      conclusion: text(r.conclusion, 240),
    });
  });
  children(mission.runs, "attempts", 6, (r, id) => {
    const knownState = oneOf(r.state, [
      "draft",
      "pending",
      "queued",
      "starting",
      "running",
      "unknown",
      "finalizing",
      "passed",
      "failed",
      "cancelled",
      "infrastructure_error",
    ]);
    const state = knownState ? String(r.state) : "unknown";
    if (!knownState) output.parts.attempts = "partial";
    facts.attempts.push({
      source: source("attempt", id),
      state,
      conclusion: text(r.conclusion, 240),
    });
  });

  const report = row(request.report);
  if (request.report === undefined) output.reportFacts = emptyReport("not_provided");
  else if (request.report === null) output.reportFacts = emptyReport("unavailable");
  else if (
    !finalReportId ||
    report.id !== finalReportId ||
    report.projectId !== projectId ||
    report.missionId !== missionId
  )
    output.reportFacts = emptyReport("rejected");
  else {
    const presentation = row(row(report.safeReport).presentation);
    if (presentation.subject !== "application" || !Array.isArray(presentation.checks))
      output.reportFacts = emptyReport("unavailable");
    else {
      // Publication's original Mission revision is not recorded here. Never
      // pretend the current Mission revision was the report's authoring revision.
      output.reportFacts = {
        ...emptyReport("available"),
        source: { ...source("report", finalReportId), missionRevision: null },
      };
      const mark = (field: Omission) => {
        output.reportFacts.state = "partial";
        output.reportFacts.omitted[field] = true;
      };
      const reportText = (value: unknown, bytes: number, field: Omission): string | null => {
        if (typeof value !== "string") {
          mark(field);
          return null;
        }
        const bounded = clip(value, bytes);
        if (bounded.truncated) {
          mark(field);
          output.truncated.otherText = true;
        }
        return bounded.text;
      };
      const items = (value: unknown, limit: number, field: Omission): unknown[] => {
        // These arrays have empty defaults in the existing presentation schema.
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
          mark(field);
          return [];
        }
        if (value.length > limit) {
          mark(field);
          if (field === "checks") output.truncated.reportChecks = true;
        }
        return value.slice(0, limit);
      };
      const references = (value: unknown): Evidence[] | undefined => {
        if (value === undefined) return undefined;
        const result: Evidence[] = [];
        for (const item of items(value, 2, "evidence")) {
          const reference = row(item);
          if (
            !uuid(reference.runId) ||
            typeof reference.artifactId !== "string" ||
            !/^[a-f0-9]{64}$/u.test(reference.artifactId)
          ) {
            mark("evidence");
            continue;
          }
          result.push({ runId: reference.runId, artifactId: reference.artifactId });
        }
        return result;
      };
      for (const field of ["scope", "limitations", "verified"] as const) {
        output.reportFacts[field] = items(presentation[field], 4, field).flatMap((item) => {
          const value = reportText(item, field === "limitations" ? 360 : 240, field);
          return value === null ? [] : [value];
        });
      }
      if (report.summary !== undefined) {
        const summary = reportText(report.summary, 360, "summary");
        if (summary !== null) output.reportFacts.summary = summary;
      }
      if (presentation.checks.length === 0) mark("checks");
      for (const value of items(presentation.checks, 8, "checks")) {
        const check = row(value),
          title = reportText(check.title, 120, "checks"),
          actual = reportText(check.actual, 360, "checks"),
          expected =
            check.expected === undefined ? null : reportText(check.expected, 360, "checks"),
          evidence = references(check.evidence);
        if (!title || !actual) {
          mark("checks");
          continue;
        }
        let status = oneOf(check.status, [
          "matched_expectation",
          "different_from_expectation",
          "inconclusive",
          "not_tested",
          "blocked",
          "excluded",
        ])
          ? check.status
          : "unclassified";
        if (oneOf(status, ["matched_expectation", "different_from_expectation"]) && !expected)
          status = "unclassified";
        if (status === "unclassified") mark("checks");
        output.reportFacts.checks.push({
          title,
          actual,
          ...(expected === null ? {} : { expected }),
          status,
          ...(evidence === undefined ? {} : { evidence }),
        });
      }
      for (const item of items(presentation.observations, 3, "observations")) {
        const observation = row(item),
          title = reportText(observation.title, 120, "observations"),
          detail = reportText(observation.detail, 360, "observations");
        const suggestion =
            observation.suggestion === undefined
              ? null
              : reportText(observation.suggestion, 240, "observations"),
          evidence = references(observation.evidence);
        if (!title || !detail) {
          mark("observations");
          continue;
        }
        output.reportFacts.observations.push({
          title,
          detail,
          ...(suggestion === null ? {} : { suggestion }),
          ...(evidence === undefined ? {} : { evidence }),
        });
      }
      for (const item of items(presentation.sections, 3, "sections")) {
        const section = row(item),
          title = reportText(section.title, 120, "sections"),
          sectionItems: Section["items"] = [];
        if (!title) {
          mark("sections");
          continue;
        }
        if (!Array.isArray(section.items) || section.items.length === 0) mark("sections");
        for (const item of items(section.items, 3, "sections")) {
          const entry = row(item),
            title = reportText(entry.title, 120, "sections"),
            detail = reportText(entry.detail, 360, "sections"),
            evidence = references(entry.evidence);
          if (!title || !detail) {
            mark("sections");
            continue;
          }
          sectionItems.push({ title, detail, ...(evidence === undefined ? {} : { evidence }) });
        }
        output.reportFacts.sections.push({ title, items: sectionItems });
      }
    }
  }
  output.parts.report = output.reportFacts.state;
  const reportIncomplete =
    output.reportFacts.state !== "available" &&
    !(output.reportFacts.state === "not_provided" && finalReportId === null);
  output.status =
    Object.values(output.truncated).some(Boolean) ||
    reportIncomplete ||
    [output.parts.mission, output.parts.objectives, output.parts.attempts].some(
      (part) => part !== "available",
    )
      ? "partial"
      : "available";
  return output;
}
