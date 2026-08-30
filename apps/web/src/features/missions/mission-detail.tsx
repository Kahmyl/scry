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
  post,
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
  const [authorizationResult, setAuthorizationResult] = useState<{
    id: string;
    status: string;
  }>();
  const authorizationRequest = protectedAuthorizationRequest(missionId);
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
  const waitingLabel =
    data.resumePointer?.externalInput?.condition === "USER_AUTHORIZATION_REQUIRED"
      ? "Waiting for authorization"
      : "Waiting for input";
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
            <span className={`mission-status mission-status-${statusTone}`}>
              {data.status === "awaiting_user" ? waitingLabel : statusLabel}
            </span>
            <span>
              {data.terminalObjectiveCount} of {data.objectiveCount} objectives resolved
            </span>
          </div>
          <h1>{data.title}</h1>
          <p>{data.originalInstruction}</p>
        </div>
        <div className="page-title-actions">
          <button className="secondary-button" onClick={onOpenFlows}>
            <FileCode2 size={15} /> Flows (
            {
              data.authoring.filter((draft) => !["published", "abandoned"].includes(draft.state))
                .length
            }{" "}
            drafts · {data.flows.length} published)
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
            <span>Flow Runs</span>
            <strong>
              {data.flowProgress.passedRuns} passed · {data.flowProgress.needsAttentionRuns}{" "}
              attention
            </strong>
          </div>
          <div>
            <span>Run evidence</span>
            <strong>{data.flowProgress.evidenceAvailable ? "Available" : "Not yet"}</strong>
          </div>
          <div className="mission-next-action">
            <span>Current Flow</span>
            <strong>
              {data.flowProgress.current
                ? `${data.flowProgress.current.name} · ${data.flowProgress.current.phase.replaceAll("_", " ")}`
                : (data.resumePointer?.explanation ?? "No active Flow")}
            </strong>
          </div>
        </div>
      </section>
      {error && <div className="form-error">{error}</div>}
      {authorizationRequest && !authorizationResult && (
        <section className="panel">
          <PanelHeader title="Authorize protected operation" kicker="OWNER APPROVAL" />
          <p>
            Review and approve this exact protected operation. This authorization binds factual
            scope only; it does not approve target correctness or workflow progression.
          </p>
          <dl>
            <dt>Mission</dt>
            <dd>{authorizationRequest.authorization.missionId}</dd>
            <dt>Objective</dt>
            <dd>{authorizationRequest.authorization.objectiveId}</dd>
            <dt>Environment</dt>
            <dd>{authorizationRequest.authorization.environmentId}</dd>
            <dt>Praxis session</dt>
            <dd>{authorizationRequest.authorization.praxisSessionId}</dd>
            <dt>Operation</dt>
            <dd>{authorizationRequest.authorization.operationId}</dd>
            <dt>Operation label</dt>
            <dd>{authorizationRequest.display.operationLabel}</dd>
            <dt>Method / target class</dt>
            <dd>
              {authorizationRequest.display.method} · {authorizationRequest.display.targetClass}
            </dd>
            <dt>Protected operation</dt>
            <dd>{authorizationRequest.authorization.preparedOperation.protectedOperationId}</dd>
            <dt>Operation contract</dt>
            <dd>{authorizationRequest.authorization.preparedOperation.contractDigest}</dd>
            <dt>Expires</dt>
            <dd>{authorizationRequest.authorization.expiresAt}</dd>
            <dt>Reason</dt>
            <dd>{authorizationRequest.authorization.reason}</dd>
          </dl>
          <button
            className="primary-button"
            onClick={() => {
              setError("");
              void post<{ id: string; status: string }>(
                `/missions/${missionId}/authorizations`,
                authorizationRequest.authorization,
              )
                .then(setAuthorizationResult)
                .catch((cause) => setError(message(cause)));
            }}
          >
            <ShieldCheck size={15} /> Authorize this protected operation
          </button>
        </section>
      )}
      {authorizationResult && (
        <section className="panel">
          <PanelHeader title="Protected operation authorized" kicker="APPROVED" />
          <p>Authorization {authorizationResult.id} is approved for the exact displayed scope.</p>
        </section>
      )}
      {data.status === "awaiting_user" && data.resumePointer?.externalInput && (
        <section className="panel">
          <PanelHeader title={waitingLabel} kicker="NON-TERMINAL" />
          <p>{data.resumePointer.externalInput.cause}</p>
          <p>{data.resumePointer.externalInput.authority.reason}</p>
          {data.resumePointer.externalInput.effectState === "unknown" && (
            <p>Effect state is unknown; blind retry is not safe.</p>
          )}
        </section>
      )}
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
        <PanelHeader title="Flow Runs" kicker={`${data.flowProgress.terminalRuns} TERMINAL`} />
        {data.runs.length ? (
          <div className="mission-evidence-list">
            {data.runs.map((run) => (
              <button key={run.id} onClick={() => onOpenRun(run.id)}>
                <span>
                  <small>
                    {run.role ?? "run"} · {relativeTime(run.updatedAt)}
                  </small>
                  <strong>{run.flowName ?? `Flow ${run.flowId?.slice(0, 8) ?? "unknown"}`}</strong>
                </span>
                <span>
                  {run.state.replaceAll("_", " ")} · {run.phase?.replaceAll("_", " ") ?? "queued"} ·{" "}
                  {run.availableEvidenceCount ?? 0} evidence <ArrowRight size={14} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyBlock
            icon={<FileCode2 />}
            title="No executed Flow Runs yet"
            copy="Authoring and probes remain separate until a qualified Flow is submitted to deterministic execution."
          />
        )}
      </section>
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

function protectedAuthorizationRequest(missionId: string) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("authorize") !== "protected") return undefined;
  const objectiveId = params.get("objectiveId");
  const environmentId = params.get("environmentId");
  const agentSessionId = params.get("agentSessionId");
  const praxisSessionId = params.get("praxisSessionId");
  const operationId = params.get("operationId");
  const protectedOperationId = params.get("protectedOperationId");
  const contractDigest = params.get("contractDigest");
  const expiresAt = params.get("expiresAt");
  const operationLabel = params.get("operationLabel");
  const method = params.get("method");
  const targetClass = params.get("targetClass");
  const reason = params.get("reason");
  if (
    !objectiveId ||
    !environmentId ||
    !agentSessionId ||
    !praxisSessionId ||
    !operationId ||
    !protectedOperationId ||
    !contractDigest ||
    !expiresAt ||
    !operationLabel ||
    !method ||
    !targetClass ||
    !reason
  )
    return undefined;
  return {
    authorization: {
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      praxisSessionId,
      operationId,
      preparedOperation: { protectedOperationId, publicOperationId: operationId, contractDigest },
      expiresAt,
      reason,
      kind: "protected_mutation" as const,
      confirmedUserAuthorized: true as const,
    },
    display: { operationLabel, method, targetClass },
  };
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
