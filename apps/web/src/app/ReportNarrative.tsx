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
    limitations = strings(p.limitations ?? value.limitations);
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
  return { verified, limitations, observations };
}
export function ReportNarrative({
  value,
  onEvidence,
}: {
  value?: Record<string, unknown>;
  onEvidence: (selection: EvidenceSelection) => void;
}) {
  const report = reportNarrative(value);
  return (
    <>
      <section className="panel">
        <h2>What was verified</h2>
        {report.verified.length ? (
          <ol>
            {report.verified.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ol>
        ) : (
          <p>
            This report does not include a separate verification checklist. Review the summary and
            individual attempts; do not infer unrecorded coverage.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Observations to review</h2>
        <p>
          Observations are not automatically a judgment that the application is defective. Recovered
          interaction problems remain part of the record.
        </p>
        {report.observations.map((item, index) => (
          <article className="report-observation" key={index}>
            <h3>{item.title}</h3>
            <p>{item.detail}</p>
            {item.suggestion && (
              <p>
                <strong>Suggestion:</strong> {item.suggestion}
              </p>
            )}
            {item.evidence.map((ref, index) => (
              <button key={index} onClick={() => onEvidence(ref)}>
                Review supporting evidence{item.evidence.length > 1 ? ` ${index + 1}` : ""}
              </button>
            ))}
          </article>
        ))}
        {!report.observations.length && (
          <p>No separate observations were recorded in this report.</p>
        )}
      </section>
      <section className="panel">
        <h2>Limitations and unverified scope</h2>
        {report.limitations.length ? (
          <ul>
            {report.limitations.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        ) : (
          <p>
            Limitations were not specified. This does not mean that every capability or scenario was
            tested.
          </p>
        )}
      </section>
    </>
  );
}
