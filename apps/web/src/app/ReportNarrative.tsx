import { ReportContentDesign } from "./TestingWorkspace.js";
export type EvidenceSelection = { runId: string; artifactId?: string };
type Observation = {
  title: string;
  detail: string;
  suggestion?: string;
  evidence: Array<{ runId: string; artifactId: string }>;
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(0, 200)
    : typeof value === "string"
      ? [value]
      : [];
}
/** Only common presentation fields, never app-specific payload keys or HTML. */
export function reportNarrative(value: Record<string, unknown> = {}) {
  const p = record(value.presentation),
    verified = strings(p.verified ?? value.verification),
    scope = strings(p.scope),
    limitations = strings(p.limitations ?? value.limitations);
  const checks = (Array.isArray(p.checks) ? p.checks : []).slice(0, 200).flatMap((item) => {
    const c = record(item);
    const labels: Record<string, string> = {
      matched_expectation: "As expected",
      different_from_expectation: "Different from expected",
      inconclusive: "Needs confirmation",
      not_tested: "Not tested",
    };
    if (
      typeof c.title !== "string" ||
      typeof c.actual !== "string" ||
      typeof c.status !== "string" ||
      !Object.hasOwn(labels, c.status)
    )
      return [];
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).flatMap((item) => {
      const ref = record(item);
      return typeof ref.runId === "string" &&
        typeof ref.artifactId === "string" &&
        /^[a-f0-9]{64}$/.test(ref.artifactId)
        ? [{ runId: ref.runId, artifactId: ref.artifactId }]
        : [];
    });
    return [
      {
        title: c.title,
        actual: c.actual,
        expected: typeof c.expected === "string" ? c.expected : undefined,
        label: labels[c.status]!,
        evidence,
      },
    ];
  });
  const raw = p.observations ?? value.findings;
  const observations: Observation[] = (Array.isArray(raw) ? raw : [])
    .slice(0, 200)
    .flatMap((item) => {
      const f = record(item),
        detail =
          typeof f.detail === "string"
            ? f.detail
            : typeof f.observation === "string"
              ? f.observation
              : "";
      if (!detail) return [];
      const title =
        typeof f.title === "string" ? f.title : detail.split(/[.!?]\s/)[0]!.slice(0, 160);
      const evidence = (Array.isArray(f.evidence) ? f.evidence : []).flatMap((item) => {
        const e = record(item);
        return typeof e.runId === "string" &&
          typeof e.artifactId === "string" &&
          /^[a-f0-9]{64}$/.test(e.artifactId)
          ? [{ runId: e.runId, artifactId: e.artifactId }]
          : [];
      });
      return [
        {
          title,
          detail,
          ...(typeof f.suggestion === "string" ? { suggestion: f.suggestion } : {}),
          evidence,
        },
      ];
    });
  return { scope, checks, verified, limitations, observations };
}
export function ReportNarrative({
  value,
  onEvidence,
}: {
  value?: Record<string, unknown>;
  onEvidence: (selection: EvidenceSelection) => void;
}) {
  return <ReportContentDesign content={reportNarrative(value)} onEvidence={onEvidence} />;
}
