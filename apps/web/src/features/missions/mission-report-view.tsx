import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Play,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { api, type MissionReport, type Report } from "../../infrastructure/api/client.js";
import { PageSkeleton } from "../../shared/components/dashboard-primitives.js";
import { AuthenticatedArtifact, AuthenticatedVideo } from "../evidence/evidence-media.js";

export function MissionReportView({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const [report, setReport] = useState<MissionReport>();
  const [evidenceRuns, setEvidenceRuns] = useState<Record<string, Report>>({});
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const [openEvidenceObjective, setOpenEvidenceObjective] = useState<string | null>(null);
  const [openEvidenceRun, setOpenEvidenceRun] = useState<string | null>(null);
  useEffect(() => {
    void api<MissionReport>(`/mission-reports/${reportId}`).then(setReport);
  }, [reportId]);
  useEffect(() => {
    if (!report) return;
    const runIds = [
      ...new Set(report.snapshot.objectiveResults.flatMap((objective) => objective.acceptedRunIds)),
    ];
    if (!runIds.length) {
      setEvidenceRuns({});
      return;
    }
    let active = true;
    setEvidenceLoading(true);
    setEvidenceError("");
    void Promise.all(
      runIds.map(async (runId) => [runId, await api<Report>(`/runs/${runId}`)] as const),
    )
      .then((entries) => {
        if (active) setEvidenceRuns(Object.fromEntries(entries));
      })
      .catch((cause) => {
        if (active) setEvidenceError(message(cause));
      })
      .finally(() => {
        if (active) setEvidenceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [report]);
  if (!report) return <PageSkeleton />;
  const snapshot = report.snapshot;
  const passed = snapshot.objectiveResults.filter(
    (objective) => objective.status === "passed",
  ).length;
  const runCount = new Set(
    snapshot.objectiveResults.flatMap((objective) => objective.acceptedRunIds),
  ).size;
  const artifactCount = new Set(
    snapshot.objectiveResults.flatMap((objective) => objective.acceptedArtifactIds),
  ).size;
  return (
    <div className="mission-report-detail">
      <button className="back-button mission-report-back" onClick={onBack}>
        <ChevronLeft size={15} /> All reports
      </button>
      <section className="mission-report-hero" id="report-overview">
        <div className="mission-report-mark">
          <FileText size={25} />
        </div>
        <div className="mission-report-heading">
          <div className="mission-report-meta">
            <span className="mission-report-state">
              <CheckCircle2 size={13} /> Published
            </span>
            <span>Revision {report.revision}</span>
            <span>{relativeTime(report.createdAt)}</span>
          </div>
          <h1>{snapshot.mission.title}</h1>
          <p>{snapshot.mission.originalInstruction}</p>
        </div>
        <div className="mission-report-conclusion">
          <span>
            <CheckCircle2 size={13} /> Overall conclusion
          </span>
          <h2>{snapshot.overallConclusion}</h2>
        </div>
        <div className="mission-report-stats">
          <div>
            <span>Objectives passed</span>
            <strong>
              {passed}
              <small> / {snapshot.objectiveResults.length}</small>
            </strong>
          </div>
          <div>
            <span>Accepted runs</span>
            <strong>{runCount}</strong>
          </div>
          <div>
            <span>Evidence artifacts</span>
            <strong>{artifactCount}</strong>
          </div>
          <div>
            <span>Superseded attempts</span>
            <strong>{snapshot.supersededAttemptCount}</strong>
          </div>
        </div>
      </section>
      <nav className="mission-report-nav" aria-label="Report sections">
        <a href="#report-overview">
          <FileText size={14} />
          Overview
        </a>
        <a href="#report-objectives">
          <CheckCircle2 size={14} />
          Objectives <span>{snapshot.objectiveResults.length}</span>
        </a>
        <a href="#report-journey">
          <Activity size={14} />
          Journey
        </a>
        <a href="#report-evidence">
          <ShieldCheck size={14} />
          Evidence <span>{runCount}</span>
        </a>
      </nav>
      <section className="mission-report-section" id="report-objectives">
        <div className="mission-report-section-head">
          <div>
            <span>Accepted evidence</span>
            <h2>Objective results</h2>
          </div>
          <small>
            {passed} of {snapshot.objectiveResults.length} passed
          </small>
        </div>
        <div className="mission-report-objectives">
          {snapshot.objectiveResults.map((objective, index) => (
            <article key={objective.id}>
              <div className="mission-report-objective-index">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="mission-report-objective-copy">
                <div>
                  <h3>{objective.title}</h3>
                  <span
                    className={
                      objective.status === "passed"
                        ? "mission-result-pass"
                        : "mission-result-neutral"
                    }
                  >
                    <CheckCircle2 size={12} />
                    {objective.status}
                  </span>
                </div>
                <p>{objective.conclusion ?? "No conclusion recorded."}</p>
                <div className="mission-report-evidence-counts">
                  <span>
                    <Play size={12} />
                    {objective.acceptedRunIds.length} accepted run
                    {objective.acceptedRunIds.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    <FileText size={12} />
                    {objective.acceptedArtifactIds.length} artifact
                    {objective.acceptedArtifactIds.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="mission-report-lower" id="report-journey">
        <details className="mission-report-section mission-report-journey">
          <summary className="mission-report-section-head">
            <div>
              <span>What happened</span>
              <h2>Journey summary</h2>
            </div>
            <small>
              {snapshot.journeySummary.length} events <ChevronDown size={15} />
            </small>
          </summary>
          <ol>
            {snapshot.journeySummary.map((item, index) => (
              <li key={`${index}-${item}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{item}</p>
              </li>
            ))}
          </ol>
        </details>
        <div className="mission-report-section mission-report-actions">
          <div className="mission-report-section-head">
            <div>
              <span>Next</span>
              <h2>Remaining actions</h2>
            </div>
          </div>
          {snapshot.remainingActions.length ? (
            <ul>
              {snapshot.remainingActions.map((item, index) => (
                <li key={`${index}-${item}`}>
                  <AlertTriangle size={15} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mission-report-complete">
              <CheckCircle2 size={24} />
              <strong>No remaining actions</strong>
              <span>This Mission is complete.</span>
            </div>
          )}
        </div>
      </section>
      <section
        className="mission-report-section mission-report-evidence-appendix"
        id="report-evidence"
      >
        <div className="mission-report-section-head">
          <div>
            <span>Evidence appendix</span>
            <h2>Accepted evidence, in reading order</h2>
          </div>
          <small>
            {runCount} accepted run{runCount === 1 ? "" : "s"}
          </small>
        </div>
        {evidenceLoading && (
          <div className="mission-report-evidence-loading">
            <LoaderCircle className="spin" size={18} /> Loading accepted evidence…
          </div>
        )}
        {evidenceError && (
          <div className="form-error mission-report-evidence-error">
            <AlertTriangle size={14} />
            {evidenceError}
          </div>
        )}
        {!evidenceLoading &&
          snapshot.objectiveResults.map((objective, objectiveIndex) => {
            const objectiveOpen = openEvidenceObjective === objective.id;
            return (
              <div
                className={`mission-report-evidence-objective ${objectiveOpen ? "open" : ""}`}
                key={objective.id}
              >
                <button
                  className="mission-report-evidence-objective-head"
                  aria-expanded={objectiveOpen}
                  onClick={() => {
                    setOpenEvidenceObjective(objectiveOpen ? null : objective.id);
                    setOpenEvidenceRun(null);
                  }}
                >
                  <span>{String(objectiveIndex + 1).padStart(2, "0")}</span>
                  <div>
                    <small>Objective</small>
                    <h3>{objective.title}</h3>
                    <p>{objective.conclusion}</p>
                  </div>
                  <div className="mission-report-evidence-summary">
                    <strong>{objective.acceptedRunIds.length}</strong>
                    <small>accepted run{objective.acceptedRunIds.length === 1 ? "" : "s"}</small>
                    <em>{objectiveOpen ? "Hide runs" : "Explore runs"}</em>
                    {objectiveOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                  </div>
                </button>
                {objectiveOpen && (
                  <div className="mission-report-evidence-objective-body">
                    {objective.acceptedRunIds.map((runId, runIndex) => {
                      const runReport = evidenceRuns[runId];
                      if (!runReport) return null;
                      const runOpen = openEvidenceRun === runId;
                      const stepOrder = new Map(
                        runReport.steps.map((step, index) => [step.stepId, index]),
                      );
                      const orderedArtifacts = [...runReport.artifacts].sort(
                        (left, right) =>
                          (stepOrder.get(left.stepId ?? "") ?? Number.MAX_SAFE_INTEGER) -
                          (stepOrder.get(right.stepId ?? "") ?? Number.MAX_SAFE_INTEGER),
                      );
                      return (
                        <article
                          className={`mission-report-evidence-run ${runOpen ? "open" : ""}`}
                          key={runId}
                        >
                          <button
                            className="mission-report-evidence-run-head"
                            aria-expanded={runOpen}
                            onClick={() => setOpenEvidenceRun(runOpen ? null : runId)}
                          >
                            <div>
                              <span className="mission-result-pass">
                                <CheckCircle2 size={12} />
                                {runReport.run.state}
                              </span>
                              <h4>Accepted Run {runIndex + 1}</h4>
                              <code>{runId.slice(0, 8)}</code>
                            </div>
                            <div>
                              <span>Integrity</span>
                              <strong>{runReport.integrity.status}</strong>
                            </div>
                            <div>
                              <span>Environment</span>
                              <strong>{runReport.run.environmentSnapshot.name}</strong>
                            </div>
                            <div>
                              <span>Artifacts</span>
                              <strong>{runReport.artifacts.length}</strong>
                            </div>
                            <span className="mission-report-run-toggle">
                              <small>{runOpen ? "Hide evidence" : "View evidence"}</small>
                              {runOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                            </span>
                          </button>
                          {runOpen && (
                            <div className="mission-report-evidence-run-body">
                              <div className="mission-report-evidence-steps">
                                {runReport.steps.map((step, stepIndex) => (
                                  <div
                                    className="mission-report-evidence-step"
                                    key={`${step.attemptId}-${step.stepId}`}
                                  >
                                    <span>{String(stepIndex + 1).padStart(2, "0")}</span>
                                    <div>
                                      <div>
                                        <strong>{step.title}</strong>
                                        <code>
                                          {runReport.run.planSnapshot.steps.find(
                                            (candidate) => candidate.id === step.stepId,
                                          )?.action.type ?? "step"}
                                        </code>
                                        <em
                                          className={
                                            step.action.status === "passed"
                                              ? "evidence-step-pass"
                                              : "evidence-step-neutral"
                                          }
                                        >
                                          {step.action.status}
                                        </em>
                                      </div>
                                      {step.readiness && (
                                        <small>
                                          Readiness: {step.readiness.status?.replaceAll("_", " ")}
                                        </small>
                                      )}
                                      {step.assertions.length > 0 && (
                                        <ul>
                                          {step.assertions.map((assertion) => (
                                            <li key={assertion.index}>
                                              <CheckCircle2 size={12} />
                                              <span>{assertion.type}</span>
                                              <em>{assertion.status}</em>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {orderedArtifacts.length > 0 && (
                                <div className="mission-report-run-artifacts">
                                  {orderedArtifacts.map((artifact) => (
                                    <div
                                      className={`mission-report-artifact mission-report-artifact-${artifact.kind}`}
                                      key={artifact.id}
                                    >
                                      {artifact.availability !== "available" ? (
                                        <div className="mission-report-unavailable-artifact">
                                          <ShieldCheck size={15} />
                                          <span>
                                            <strong>{artifact.kind}</strong>
                                            <small>
                                              {artifact.availability} · no artifact bytes exposed
                                            </small>
                                          </span>
                                        </div>
                                      ) : artifact.kind === "video" ? (
                                        <AuthenticatedVideo artifact={artifact} />
                                      ) : artifact.kind === "screenshot" ? (
                                        <div className="evidence-grid">
                                          <AuthenticatedArtifact artifact={artifact} image />
                                        </div>
                                      ) : (
                                        <div className="artifact-strip">
                                          <AuthenticatedArtifact artifact={artifact} />
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
      </section>
    </div>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(value: string) {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
