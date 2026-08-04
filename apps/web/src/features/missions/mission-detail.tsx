import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Eye,
  FileCode2,
  FileText,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  api,
  type MissionDetail,
  type MissionReport,
  type MissionSummary,
} from "../../infrastructure/api/client.js";
import {
  EmptyBlock,
  PageSkeleton,
  PageTitle,
  PanelHeader,
  StatusBadge,
} from "../../shared/components/dashboard-primitives.js";

export function MissionDetailPage({
  missionId,
  onBack,
  onOpenFlows,
  onOpenRun,
  onOpenReport,
}: {
  missionId: string;
  onBack: () => void;
  onOpenFlows: () => void;
  onOpenRun: (id: string) => void;
  onOpenReport: (id: string) => void;
}) {
  const [data, setData] = useState<MissionDetail>();
  const [activities, setActivities] = useState<
    Array<{ id: string; type: string; summary: string; occurredAt: string; technical: boolean }>
  >([]);
  const [technical, setTechnical] = useState(false);
  const [error, setError] = useState("");
  const [authoringOpen, setAuthoringOpen] = useState(false);
  const load = useCallback(() => {
    void Promise.all([
      api<MissionDetail>(`/missions/${missionId}`),
      api<typeof activities>(`/missions/${missionId}/activities?technical=${technical}`),
    ])
      .then(([mission, nextActivities]) => {
        setData(mission);
        setActivities(nextActivities);
      })
      .catch((cause) => setError(message(cause)));
  }, [missionId, technical]);
  useEffect(load, [load]);
  if (!data) return <PageSkeleton />;
  const statusLabel = data.status.replaceAll("_", " ");
  const statusTone =
    data.status === "completed"
      ? "success"
      : ["failed", "blocked"].includes(data.status)
        ? "danger"
        : "active";
  return (
    <div className="mission-detail">
      <button className="back-button mission-back" onClick={onBack}>
        <ChevronLeft size={15} /> Back to Missions
      </button>
      <section className={`mission-hero mission-hero-${statusTone}`}>
        <div className="mission-hero-copy">
          <div className="mission-hero-meta">
            <span className={`mission-status mission-status-${statusTone}`}>{statusLabel}</span>
            <span>
              {data.terminalObjectiveCount} of {data.objectiveCount} objectives resolved
            </span>
          </div>
          <h1>{data.title}</h1>
          <p>{data.originalInstruction}</p>
        </div>
        <div className="page-title-actions">
          <button className="secondary-button" onClick={onOpenFlows}>
            <FileCode2 size={15} /> Flows ({data.flows.length})
          </button>
          {data.resumePointer?.runId && (
            <button
              className="secondary-button"
              onClick={() => onOpenRun(data.resumePointer!.runId!)}
            >
              Inspect current Run <ArrowRight size={15} />
            </button>
          )}
          {data.latestReportId && (
            <button className="secondary-button" onClick={() => onOpenReport(data.latestReportId!)}>
              View report
            </button>
          )}
        </div>
        <div className="mission-summary-strip">
          <div>
            <span>Progress</span>
            <strong>
              {data.terminalObjectiveCount}/{data.objectiveCount}
            </strong>
          </div>
          <div>
            <span>Accepted evidence</span>
            <strong>{data.acceptedEvidenceCount}</strong>
          </div>
          <div className="mission-next-action">
            <span>Next action</span>
            <strong>{data.resumePointer?.explanation ?? "No pending action"}</strong>
          </div>
        </div>
      </section>
      {error && <div className="form-error">{error}</div>}
      <section className="mission-detail-grid">
        <div className="panel mission-objectives-panel">
          <PanelHeader title="Objectives" kicker="OUTCOMES" />
          <div className="mission-objective-list">
            {data.objectives.map((objective) => {
              const accepted = data.acceptedEvidence.filter(
                (evidence) => evidence.objectiveId === objective.id,
              );
              const awaiting = objective.orchestrationState === "awaiting_evidence";
              return (
                <article className="mission-objective-card" key={objective.id}>
                  <div className="mission-objective-index">
                    {String(objective.order + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <div className="mission-objective-title">
                      <strong>{objective.title}</strong>
                      {awaiting ? (
                        <span className="draft-tag">awaiting evidence</span>
                      ) : (
                        <StatusBadge
                          state={
                            objective.status === "passed"
                              ? "passed"
                              : objective.status === "failed"
                                ? "failed"
                                : "running"
                          }
                        />
                      )}
                    </div>
                    <p>{objective.conclusion ?? objective.description}</p>
                    <span>
                      {accepted.length
                        ? `${accepted.length} accepted evidence record${accepted.length === 1 ? "" : "s"}`
                        : awaiting
                          ? "Candidate Run ready for review"
                          : "No evidence accepted yet"}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
        <div className="panel mission-journey-panel">
          <PanelHeader
            title="Journey"
            kicker="MEANINGFUL ACTIVITY"
            action={technical ? "Hide technical" : "Show technical"}
            onAction={() => setTechnical((current) => !current)}
          />
          <div className="mission-timeline">
            {activities.map((activity) => (
              <div key={activity.id}>
                <span />
                <div>
                  <strong>{activity.summary}</strong>
                  <small>
                    {relativeTime(activity.occurredAt)}
                    {activity.technical ? " · technical" : ""}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {data.authoring.length > 0 && (
        <section className="panel mission-authoring-panel">
          <button
            className="mission-authoring-toggle"
            onClick={() => setAuthoringOpen((value) => !value)}
            aria-expanded={authoringOpen}
          >
            <span>
              <Wrench size={17} />
              <span>
                <small>AUTHORING ACTIVITY</small>
                <strong>
                  {data.authoring.reduce((total, draft) => total + draft.probes.length, 0)} Probe
                  Session
                  {data.authoring.reduce((total, draft) => total + draft.probes.length, 0) === 1
                    ? ""
                    : "s"}
                </strong>
              </span>
            </span>
            <span>
              Drafts, calibration, and compilation do not count as failed Runs{" "}
              <ChevronDown className={authoringOpen ? "expanded" : ""} size={18} />
            </span>
          </button>
          {authoringOpen && (
            <div className="mission-authoring-list">
              {data.authoring.map((draft) => (
                <article key={draft.id}>
                  <div>
                    <strong>{draft.name}</strong>
                    <span>
                      Draft v{draft.version} · {draft.state.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="mission-authoring-pills">
                    <span>{draft.probes.length} probes</span>
                    <span>
                      {draft.compilations[0]?.status?.replaceAll("_", " ") ?? "not compiled"}
                    </span>
                  </div>
                  {draft.probes.map((probe) => (
                    <div className="mission-authoring-probe" key={probe.id}>
                      <span>{probe.level.replaceAll("_", " ")}</span>
                      <strong>{probe.state}</strong>
                      <small>
                        {probe.result?.allResolved === true
                          ? "All contracts resolved"
                          : probe.result?.diagnostics?.length
                            ? `${probe.result.diagnostics.length} authoring issue${probe.result.diagnostics.length === 1 ? "" : "s"}`
                            : "Awaiting diagnostic result"}
                      </small>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      <section className="panel mission-evidence-panel">
        <PanelHeader title="Accepted evidence" kicker="AUTHORITATIVE SET" />
        {data.acceptedEvidence.length ? (
          <div className="mission-evidence-list">
            {data.acceptedEvidence.map((evidence) => {
              const objective = data.objectives.find(
                (candidate) => candidate.id === evidence.objectiveId,
              );
              return (
                <button key={evidence.id} onClick={() => onOpenRun(evidence.runId)}>
                  <span>
                    <small>{objective?.title ?? "Objective"}</small>
                    <strong>{evidence.conclusion}</strong>
                  </span>
                  <span>
                    Run {evidence.runId.slice(0, 8)} <ArrowRight size={14} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyBlock
            icon={<ShieldCheck />}
            title="No accepted evidence yet"
            copy="Candidate Runs remain reviewable and do not become Mission conclusions until explicitly accepted."
          />
        )}
      </section>
    </div>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
