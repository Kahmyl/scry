import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Play,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  api,
  type MissionReport,
  type RecordingTimelineEntry,
  type Report,
} from "../../infrastructure/api/client.js";
import { PageSkeleton } from "../../shared/components/dashboard-primitives.js";
import {
  AuthenticatedArtifact,
  AuthenticatedVideo,
  RecordingPlaylist,
} from "../evidence/evidence-media.js";

export function MissionReportView({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const [report, setReport] = useState<MissionReport>();
  const [openEvidenceObjective, setOpenEvidenceObjective] = useState<string | null>(null);
  useEffect(() => {
    void api<MissionReport>(`/mission-reports/${reportId}`).then(setReport);
  }, [reportId]);
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
  const missionRecording = recordingPlayback(snapshot.recording ?? null);
  const relatedMissions = snapshot.relatedMissions ?? [];
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
      {relatedMissions.length > 0 && (
        <section className="mission-report-section" aria-label="Related Mission provenance">
          <div className="mission-report-section-head">
            <div>
              <span>Factual provenance, not accepted evidence</span>
              <h2>Related Missions</h2>
            </div>
            <small>{relatedMissions.length} immutable relations</small>
          </div>
          <div className="mission-report-evidence-objective-body">
            {relatedMissions.map((relation) => (
              <article className="mission-report-evidence-run open" key={relation.relationId}>
                <div className="mission-report-evidence-run-head">
                  <div>
                    <span>{relation.direction}</span>
                    <h4>{relation.relation.replaceAll("_", " ")}</h4>
                    <code>{relation.relatedMission.id}</code>
                  </div>
                  <div>
                    <span>Purpose</span>
                    <strong>{relation.relatedMission.purpose}</strong>
                  </div>
                  <div>
                    <span>Mission state</span>
                    <strong>{relation.relatedMission.status}</strong>
                  </div>
                  <div>
                    <span>Unresolved recovery</span>
                    <strong>{relation.unresolvedProtectedOperations.length}</strong>
                  </div>
                </div>
                <div className="mission-report-evidence-run-body">
                  <p>{relation.reason}</p>
                  {relation.unresolvedProtectedOperations.map((operation) => (
                    <div
                      className="mission-report-unavailable-artifact"
                      key={operation.protectedOperationId}
                    >
                      <AlertTriangle size={15} />
                      <span>
                        <strong>{operation.mutationOutcome} mutation truth</strong>
                        <small>
                          {operation.operationId} · {operation.state}
                          {operation.recoveryClass ? ` · ${operation.recoveryClass}` : ""}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {missionRecording.entries.length > 0 && (
        <section className="mission-report-section" aria-label="Mission recording composition">
          <div className="mission-report-section-head">
            <div>
              <span>Immutable segment manifest</span>
              <h2>Mission recording</h2>
            </div>
            <small>{missionRecording.entries.length} segments and boundaries</small>
          </div>
          <RecordingPlaylist
            entries={missionRecording.entries}
            artifacts={missionRecording.artifacts}
          />
        </section>
      )}
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
        {snapshot.objectiveResults.map((objective, objectiveIndex) => {
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
                  {selectedEvidenceByRun(snapshot, objective.id).map((acceptedRun, runIndex) => {
                    return (
                      <article className="mission-report-evidence-run open" key={acceptedRun.id}>
                        <div className="mission-report-evidence-run-head">
                          <div>
                            <span className="mission-result-pass">
                              <CheckCircle2 size={12} />
                              {acceptedRun.state}
                            </span>
                            <h4>Accepted Run {runIndex + 1}</h4>
                            <code>{acceptedRun.id.slice(0, 8)}</code>
                          </div>
                          <div>
                            <span>Canonical Attempt</span>
                            <strong>{acceptedRun.canonicalAttemptId.slice(0, 8)}</strong>
                          </div>
                          <div>
                            <span>Environment</span>
                            <strong>{acceptedRun.environmentId.slice(0, 8)}</strong>
                          </div>
                          <div>
                            <span>Selected artifacts</span>
                            <strong>{acceptedRun.artifacts.length}</strong>
                          </div>
                        </div>
                        <div className="mission-report-evidence-run-body">
                          <p>{acceptedRun.conclusion}</p>
                          {acceptedRun.artifacts.length > 0 && (
                            <div className="mission-report-run-artifacts">
                              {acceptedRun.artifacts.map((artifact) => (
                                <div
                                  className={`mission-report-artifact mission-report-artifact-${artifact.kind}`}
                                  key={artifact.id}
                                >
                                  {artifact.stepId && <code>{artifact.stepId}</code>}
                                  {artifact.kind === "video" ? (
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

function relativeTime(value: string) {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function selectedEvidenceByRun(snapshot: MissionReport["snapshot"], objectiveId: string) {
  const selected = snapshot.evidence.objectives.find(
    (objective) => objective.objectiveId === objectiveId,
  );
  const grouped = new Map<
    string,
    {
      id: string;
      state: string;
      environmentId: string;
      canonicalAttemptId: string;
      conclusion: string;
      artifacts: Report["artifacts"];
    }
  >();
  for (const fact of selected?.acceptedEvidence ?? []) {
    const run = grouped.get(fact.runId) ?? {
      id: fact.runId,
      state: fact.run.state,
      environmentId: fact.run.environmentId,
      canonicalAttemptId: fact.canonicalAttempt.id,
      conclusion: fact.acceptanceConclusion,
      artifacts: [],
    };
    if (fact.artifact)
      run.artifacts.push({
        id: fact.artifact.id,
        attemptId: fact.artifact.attemptId,
        ...(fact.artifact.stepId ? { stepId: fact.artifact.stepId } : {}),
        kind: fact.artifact.kind,
        availability: fact.artifact.availability as Report["artifacts"][number]["availability"],
        privacyClassification: fact.artifact
          .privacyClassification as Report["artifacts"][number]["privacyClassification"],
        contentType: fact.artifact.contentType,
        ...(fact.artifact.sizeBytes === null ? {} : { sizeBytes: fact.artifact.sizeBytes }),
      });
    grouped.set(fact.runId, run);
  }
  return [...grouped.values()];
}

export function recordingPlayback(recording: MissionReport["snapshot"]["recording"]) {
  if (!recording)
    return {
      entries: [] as RecordingTimelineEntry[],
      artifacts: [] as Report["artifacts"],
    };
  const entries: RecordingTimelineEntry[] = [];
  const artifacts: Report["artifacts"] = [];
  const boundaryBySuccessor = new Map(
    recording.boundaries.map((boundary) => [boundary.successorRunId, boundary]),
  );

  for (const selected of [...recording.runs].sort((left, right) => left.order - right.order)) {
    const boundary = boundaryBySuccessor.get(selected.run.id);
    if (boundary)
      entries.push({
        type: "recording_boundary",
        id: `boundary-${boundary.predecessorRunId}-${boundary.successorRunId}`,
        sequence: entries.length,
        boundaryKind: boundary.kind,
        ...(boundary.kind === "recording_gap"
          ? { startedAt: boundary.startedAt, endedAt: boundary.endedAt, reason: boundary.reason }
          : { reason: "successor_checkpoint_verified" }),
      });

    for (const fact of selected.timeline) {
      if (fact.artifact && fact.artifact.availability === "available")
        artifacts.push({
          id: fact.artifact.id,
          attemptId: fact.artifact.attemptId,
          kind: fact.artifact.kind,
          availability: "available",
          privacyClassification: fact.artifact.privacyClassification as "safe" | "sanitized",
          contentType: fact.artifact.contentType,
          ...(fact.artifact.sizeBytes === null ? {} : { sizeBytes: fact.artifact.sizeBytes }),
        });

      if (fact.entryType === "video_segment") {
        if (!fact.endedAt) {
          entries.push({
            type: "unavailable_interval",
            id: `${selected.canonicalAttempt.id}-${fact.sequence}`,
            sequence: entries.length,
            startedAt: fact.startedAt,
            endedAt: fact.startedAt,
            failureCode: "SEGMENT_END_UNAVAILABLE",
          });
          continue;
        }
        entries.push({
          type: "video_segment",
          id: `${selected.canonicalAttempt.id}-${fact.sequence}`,
          sequence: entries.length,
          pageId: selected.run.id,
          startedAt: fact.startedAt,
          endedAt: fact.endedAt,
          reason: fact.reason ?? "run_started",
          status: fact.mediaDisposition === "playable" ? "available" : "quarantined",
          privacyStatus: fact.mediaDisposition === "playable" ? "verified_safe" : "quarantined",
          ...(fact.artifactId ? { artifactId: fact.artifactId } : {}),
          ...(fact.mediaDisposition === "playable" ? {} : { failureCode: "SEGMENT_OMITTED" }),
        });
      } else if (fact.entryType === "protected_gap" && fact.operationId && fact.endedAt)
        entries.push({
          type: "protected_gap",
          id: `${selected.canonicalAttempt.id}-${fact.sequence}`,
          sequence: entries.length,
          operationId: fact.operationId,
          startedAt: fact.startedAt,
          endedAt: fact.endedAt,
          reason: fact.reason ?? "protected_operation",
          privacyStatus: "capture_suppressed",
        });
      else if (fact.entryType === "document_transition_gap" && fact.operationId && fact.endedAt)
        entries.push({
          type: "document_transition_gap",
          id: `${selected.canonicalAttempt.id}-${fact.sequence}`,
          sequence: entries.length,
          operationId: fact.operationId,
          startedAt: fact.startedAt,
          endedAt: fact.endedAt,
          reason: fact.reason ?? "navigation_boundary",
        });
      else if (fact.entryType === "unavailable_interval" && fact.endedAt)
        entries.push({
          type: "unavailable_interval",
          id: `${selected.canonicalAttempt.id}-${fact.sequence}`,
          sequence: entries.length,
          startedAt: fact.startedAt,
          endedAt: fact.endedAt,
          failureCode: fact.reason ?? "RECORDING_UNAVAILABLE",
        });
    }
  }
  return { entries, artifacts };
}
