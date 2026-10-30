import { Activity, AlertTriangle, ArrowRight, Eye, FileText, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

import { Integrations } from "../features/settings/integrations.js";
import { api, type Project } from "../infrastructure/api/index.js";
import { EmptyBlock, PageSkeleton, PageTitle } from "../shared/components/index.js";
import { reconcileProjectSelection } from "../shared/state/index.js";
import {
  BootScreen,
  CreateProjectDialog,
  EmptyWorkspace,
  Sidebar,
  Topbar,
} from "./components/index.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { RunEvidence } from "./RunEvidence.js";

type Mission = {
  id: string;
  projectId: string;
  title: string;
  originalInstruction: string;
  state: string;
  status: string;
  revision: number;
  objectiveCount: number;
  terminalObjectiveCount: number;
  acceptedEvidenceCount: number;
  finalReportId?: string;
  createdAt: string;
  updatedAt: string;
};

type MissionDetail = {
  id: string;
  title: string;
  instruction: string;
  state: string;
  revision: number;
  finalReportId?: string;
  objectives: Array<{
    id: string;
    title: string;
    description: string;
    state: string;
    conclusion?: string;
  }>;
  flows: Array<{ id: string; name: string; purpose: string; state: string; revision: number }>;
  runs: Array<{
    id: string;
    flowId: string;
    objectiveId: string;
    state: string;
    outcomeClassification?: string;
  }>;
};

type Run = {
  id: string;
  missionId: string;
  objectiveId: string;
  flowId: string;
  flowName: string;
  state: string;
  outcomeClassification?: string;
  environmentName: string;
  baseOrigin: string;
  browserSessionState?: string;
  artifactCount: number;
  completeEvidenceStreams: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type RunDetail = Run & {
  flowPurpose: string;
  flowDefinition: Record<string, unknown>;
  authenticationCommitsUsed: number;
  authenticationCommitLimit: number;
  businessCommitsUsed: number;
  businessCommitLimit: number;
  effects: Array<{
    id: string;
    effectClass: string;
    effectOrdinal: number;
    dispatchState: string;
    captureState: string;
    publicationState: string;
    mutationOutcome: string;
    reasonCode?: string;
  }>;
  evidence: Array<{
    id: string;
    state: string;
    chainHead?: string;
    chunkCount: number;
    totalBytes: string;
    sealedAt?: string;
    interruptions: number;
    custodyMode: "legacy" | "admitted";
    closureIssue?: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: string;
    digest: string;
    safeMetadata: Record<string, unknown>;
  }>;
};

type Report = {
  id: string;
  missionId: string;
  missionTitle: string;
  originalInstruction?: string;
  state: string;
  summary: string;
  safeReport?: Record<string, unknown>;
  evidenceCoverage?: {
    runs: number;
    complete: number;
    incomplete: number;
    open: number;
    missing: number;
    unavailable?: number;
  };
  evidenceDigest: string;
  createdAt: string;
  finalizedAt?: string;
};

export function Dashboard({
  userEmail,
  onSignOut,
}: {
  userEmail: string;
  onSignOut?: () => void | Promise<void>;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem("scry:project") ?? "");
  const [loading, setLoading] = useState(true);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const missionId = matchPath("/dashboard/missions/:missionId", location.pathname)?.params
    .missionId;
  const runId = matchPath("/dashboard/runs/:runId", location.pathname)?.params.runId;
  const reportId = matchPath("/dashboard/reports/:reportId", location.pathname)?.params.reportId;
  const view = dashboardView(location.pathname);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<Project[]>("/projects");
      setProjects(data);
      setProjectId((selected) => {
        const next = reconcileProjectSelection(data, selected);
        if (next) localStorage.setItem("scry:project", next);
        else localStorage.removeItem("scry:project");
        return next;
      });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadProjects(), [loadProjects]);
  if (loading) return <BootScreen />;

  const selectProject = (id: string) => {
    setProjectId(id);
    localStorage.setItem("scry:project", id);
    navigate("/dashboard");
  };

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        projectId={projectId}
        view={view}
        onSelectProject={selectProject}
        onNavigate={(next) => navigate(next === "overview" ? "/dashboard" : `/dashboard/${next}`)}
        onCreateProject={() => setCreateProjectOpen(true)}
      />
      <main className="main-stage">
        <Topbar
          project={projects.find((project) => project.id === projectId)}
          userEmail={userEmail}
          onWorkspaceSettings={() => navigate("/dashboard/settings")}
          onAccountSettings={() => navigate("/dashboard/account")}
          {...(onSignOut ? { onSignOut } : {})}
        />
        {error && <ErrorBanner value={error} onDismiss={() => setError("")} />}
        <div className="page-wrap">
          {view === "account" ? (
            <AccountView userEmail={userEmail} />
          ) : view === "integrations" ? (
            <Integrations />
          ) : !projectId ? (
            <EmptyWorkspace onCreate={() => setCreateProjectOpen(true)} />
          ) : view === "settings" ? (
            <ProjectSettings projectId={projectId} />
          ) : reportId ? (
            <ReportDetail reportId={reportId} onBack={() => navigate("/dashboard/reports")} />
          ) : runId ? (
            <RunDetailView runId={runId} onBack={() => navigate("/dashboard/runs")} />
          ) : missionId ? (
            <MissionDetailView
              missionId={missionId}
              onBack={() => navigate("/dashboard/missions")}
            />
          ) : view === "missions" ? (
            <MissionList
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/missions/${id}`)}
            />
          ) : view === "runs" ? (
            <RunList projectId={projectId} onOpen={(id) => navigate(`/dashboard/runs/${id}`)} />
          ) : view === "reports" ? (
            <ReportList
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/reports/${id}`)}
            />
          ) : (
            <Overview projectId={projectId} onNavigate={navigate} />
          )}
        </div>
      </main>
      {createProjectOpen && (
        <CreateProjectDialog
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(project) => {
            setProjects((current) => [project, ...current]);
            selectProject(project.id);
            setCreateProjectOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Overview({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (path: string) => void;
}) {
  const [data, setData] = useState<{ missions: Mission[]; runs: Run[]; reports: Report[] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([
      api<Mission[]>(`/projects/${projectId}/missions`),
      api<Run[]>(`/projects/${projectId}/runs`),
      api<Report[]>(`/projects/${projectId}/reports`),
    ])
      .then(([missions, runs, reports]) => setData({ missions, runs, reports }))
      .catch((cause) => setError(message(cause)));
  }, [projectId]);
  if (error) return <LoadFailure value={error} />;
  if (!data) return <PageSkeleton />;
  return (
    <>
      <PageTitle
        eyebrow="PROJECT OVERVIEW"
        title="Dashboard"
        copy="Mission progress, browser runs, durable evidence, and final reports for this project."
      />
      <section className="metric-grid metric-grid-compact">
        <Metric label="Missions" value={data.missions.length} />
        <Metric
          label="Active runs"
          value={data.runs.filter((run) => !isTerminal(run.state)).length}
        />
        <Metric label="Final reports" value={data.reports.length} />
      </section>
      <section className="content-grid">
        <div className="panel span-2">
          <ListHeading title="Recent runs" onOpen={() => onNavigate("/dashboard/runs")} />
          <RunRows
            runs={data.runs.slice(0, 6)}
            onOpen={(id) => onNavigate(`/dashboard/runs/${id}`)}
          />
        </div>
        <div className="panel">
          <ListHeading title="Recent missions" onOpen={() => onNavigate("/dashboard/missions")} />
          <MissionRows
            missions={data.missions.slice(0, 6)}
            onOpen={(id) => onNavigate(`/dashboard/missions/${id}`)}
          />
        </div>
      </section>
    </>
  );
}

function MissionList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const state = useResource<Mission[]>(`/projects/${projectId}/missions`);
  return (
    <ResourcePage
      state={state}
      title="Missions"
      eyebrow="MISSION HISTORY"
      copy="Agent-directed work, including multiple Flows and Runs inside one Mission."
    >
      <MissionRows missions={state.data ?? []} onOpen={onOpen} />
    </ResourcePage>
  );
}

function RunList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const state = useResource<Run[]>(`/projects/${projectId}/runs`, 2_000);
  return (
    <ResourcePage
      state={state}
      title="Runs"
      eyebrow="EXECUTION HISTORY"
      copy="Current and completed browser executions with durable evidence state."
    >
      <RunRows runs={state.data ?? []} onOpen={onOpen} />
    </ResourcePage>
  );
}

function ReportList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const state = useResource<Report[]>(`/projects/${projectId}/reports`);
  return (
    <ResourcePage
      state={state}
      title="Reports"
      eyebrow="FINAL EVIDENCE"
      copy="Sanitized Mission conclusions derived from completed durable evidence."
    >
      <div className="run-list browser-list">
        {(state.data ?? []).map((report) => (
          <button key={report.id} onClick={() => onOpen(report.id)}>
            <span className="run-primary">
              <strong>{report.missionTitle}</strong>
              <span>{report.summary}</span>
            </span>
            <StateBadge state={report.state} />
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
    </ResourcePage>
  );
}

function MissionDetailView({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const state = useResource<MissionDetail>(`/missions/${missionId}`, 2_000);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const mission = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle
        eyebrow={`MISSION · REVISION ${mission.revision}`}
        title={mission.title}
        copy={mission.instruction}
      />
      <section className="metric-grid metric-grid-compact">
        <Metric label="State" value={human(mission.state)} state={mission.state} />
        <Metric label="Objectives" value={mission.objectives.length} />
        <Metric label="Flows / Runs" value={`${mission.flows.length} / ${mission.runs.length}`} />
      </section>
      <section className="content-grid">
        <div className="panel">
          <ListHeading title="Objectives" />
          {mission.objectives.map((item) => (
            <Fact
              key={item.id}
              title={item.title}
              detail={item.conclusion ?? item.description}
              state={item.state}
            />
          ))}
        </div>
        <div className="panel">
          <ListHeading title="Flows" />
          {mission.flows.map((item) => (
            <Fact key={item.id} title={item.name} detail={item.purpose} state={item.state} />
          ))}
        </div>
      </section>
      {mission.runs.map((run) => (
        <MissionRunEvidence key={run.id} run={run} />
      ))}
    </>
  );
}

function MissionRunEvidence({ run }: { run: MissionDetail["runs"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Run {run.id.slice(0, 8)} · {human(run.state)} · evidence
      </summary>
      {open && <RunEvidence runId={run.id} />}
    </details>
  );
}

const evidenceIssueMessages: Readonly<Record<string, string>> = {
  object_unavailable:
    "Scry could not read the captured recording. No replay is available; this is an evidence-storage issue, not a finding about your application.",
  integrity_mismatch:
    "The captured recording did not match its admitted receipt. Scry has withheld the replay; this is an evidence-integrity issue, not a finding about your application.",
  content_unverifiable:
    "Scry could not verify the encrypted recording with the available read capability. No replay is available; this does not establish that your application is broken or that the recording was tampered with.",
  video_unavailable:
    "The captured evidence was verified, but Scry could not produce its video. No video is available; this is a recording-processing issue, not a finding about your application.",
  publication_unavailable:
    "Scry could not publish the recording artifacts. No replay is available; this is an evidence-publication issue, not a finding about your application.",
};
function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const state = useResource<RunDetail>(`/runs/${runId}`, 2_000);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const run = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle
        eyebrow={`RUN #${run.id.slice(0, 8)}`}
        title={run.flowName}
        copy={`${run.environmentName} · ${run.baseOrigin}`}
      />
      <section className="metric-grid metric-grid-compact">
        <Metric label="State" value={human(run.state)} state={run.state} />
        <Metric
          label="Authentication effects"
          value={`${run.authenticationCommitsUsed}/${run.authenticationCommitLimit}`}
        />
        <Metric
          label="Business effects"
          value={`${run.businessCommitsUsed}/${run.businessCommitLimit}`}
        />
      </section>
      <section className="panel">
        <ListHeading title="Effect truth" />
        {run.effects.map((effect) => (
          <Fact
            key={effect.id}
            title={`${human(effect.effectClass)} #${effect.effectOrdinal}`}
            detail={`dispatch ${human(effect.dispatchState)} · capture ${human(effect.captureState)} · publication ${human(effect.publicationState)}`}
            state={effect.mutationOutcome}
          />
        ))}
        {!run.effects.length && (
          <EmptyBlock
            icon={<ShieldCheck />}
            title="No mutation effects"
            copy="This Run has not admitted a browser mutation."
          />
        )}
      </section>
      <RunEvidence runId={runId} />
      <section className="panel">
        <ListHeading title="Evidence" />
        {run.evidence.map((item) => (
          <Fact
            key={item.id}
            title={
              item.closureIssue
                ? item.closureIssue === "video_unavailable"
                  ? "Video unavailable"
                  : "Recording unavailable"
                : `${item.chunkCount} durable chunk${item.chunkCount === 1 ? "" : "s"}`
            }
            detail={
              item.closureIssue
                ? (evidenceIssueMessages[item.closureIssue] ??
                  "This recording is unavailable. Scry has not published unverifiable evidence.")
                : `${item.totalBytes} bytes · chain ${item.chainHead?.slice(0, 12) ?? "unavailable"}${item.interruptions ? ` · ${item.interruptions} recording interruption${item.interruptions === 1 ? "" : "s"}; this is not a complete recording` : ""}${item.state === "incomplete" && !item.chunkCount ? " · Recording unavailable; no captured evidence was admitted" : ""}`
            }
            state={item.state}
          />
        ))}
        {!run.evidence.length && (
          <EmptyBlock
            icon={<FileText />}
            title="No evidence stream yet"
            copy="Evidence appears after the browser runtime starts this Run."
          />
        )}
      </section>
    </>
  );
}

function ReportDetail({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const state = useResource<Report>(`/reports/${reportId}`);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const report = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle eyebrow="FINAL MISSION REPORT" title={report.missionTitle} copy={report.summary} />
      <section className="panel">
        <ListHeading title="Evidence integrity" />
        <Fact title="Evidence chain digest" detail={report.evidenceDigest} state={report.state} />
        {report.evidenceCoverage && (
          <p role="status">
            Evidence coverage: {report.evidenceCoverage.complete} complete,{" "}
            {report.evidenceCoverage.incomplete} incomplete, {report.evidenceCoverage.open} still
            open, {report.evidenceCoverage.missing} unavailable.
            {!!report.evidenceCoverage.unavailable &&
              ` ${report.evidenceCoverage.unavailable} of the incomplete attempts also have unavailable recording artifacts.`}
            {report.evidenceCoverage.complete < report.evidenceCoverage.runs &&
              " Some attempts do not have a complete recording. Review those attempts before relying on their visual evidence."}
          </p>
        )}
      </section>
      <section className="panel">
        <ListHeading title="Sanitized result" />
        <pre className="browser-safe-report">
          {JSON.stringify(report.safeReport ?? {}, null, 2)}
        </pre>
      </section>
    </>
  );
}

function ResourcePage({
  state,
  title,
  eyebrow,
  copy,
  children,
}: {
  state: { data?: unknown; error: string };
  title: string;
  eyebrow: string;
  copy: string;
  children: ReactNode;
}) {
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  return (
    <>
      <PageTitle eyebrow={eyebrow} title={title} copy={copy} />
      <section className="panel">{children}</section>
    </>
  );
}

function MissionRows({ missions, onOpen }: { missions: Mission[]; onOpen: (id: string) => void }) {
  if (!missions.length)
    return (
      <EmptyBlock
        icon={<Eye />}
        title="No Missions yet"
        copy="Connect an MCP agent to create the first Mission."
      />
    );
  return (
    <div className="run-list browser-list">
      {missions.map((mission) => (
        <button key={mission.id} onClick={() => onOpen(mission.id)}>
          <span className="run-primary">
            <strong>{mission.title}</strong>
            <span>
              {mission.terminalObjectiveCount} of {mission.objectiveCount} objectives ·{" "}
              {mission.acceptedEvidenceCount} evidence streams
            </span>
          </span>
          <StateBadge state={mission.state} />
          <ArrowRight size={16} />
        </button>
      ))}
    </div>
  );
}

function RunRows({ runs, onOpen }: { runs: Run[]; onOpen: (id: string) => void }) {
  if (!runs.length)
    return (
      <EmptyBlock
        icon={<Activity />}
        title="No Runs yet"
        copy="Runs appear when an MCP agent starts browser execution."
      />
    );
  return (
    <div className="run-list browser-list">
      {runs.map((run) => (
        <button key={run.id} onClick={() => onOpen(run.id)}>
          <span className="run-primary">
            <strong>{run.flowName}</strong>
            <span>
              {run.environmentName} · {run.completeEvidenceStreams} complete evidence stream
              {run.completeEvidenceStreams === 1 ? "" : "s"}
            </span>
          </span>
          <StateBadge state={run.state} />
          <ArrowRight size={16} />
        </button>
      ))}
    </div>
  );
}

function useResource<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<T>(path)
        .then((next) => {
          if (active) {
            setData(next);
            setError("");
          }
        })
        .catch((cause) => {
          if (active) setError(message(cause));
        });
    load();
    const timer = intervalMs ? window.setInterval(load, intervalMs) : undefined;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [intervalMs, path]);
  return useMemo(() => ({ data, error }), [data, error]);
}

function ListHeading({ title, onOpen }: { title: string; onOpen?: () => void }) {
  return (
    <div className="panel-head">
      <h2>{title}</h2>
      {onOpen && (
        <button onClick={onOpen}>
          View all <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  state,
}: {
  label: string;
  value: string | number;
  state?: string;
}) {
  const tone =
    !state || ["passed", "completed", "complete", "resolved"].includes(state)
      ? "lime"
      : ["failed", "infrastructure_error", "timed_out", "corrupt"].includes(state)
        ? "failure"
        : "";
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Fact({ title, detail, state }: { title: string; detail: string; state: string }) {
  return (
    <div className="browser-fact">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <StateBadge state={state} />
    </div>
  );
}
function StateBadge({ state }: { state: string }) {
  return <span className={`status status-${state}`}>{human(state)}</span>;
}
function Back({ onClick }: { onClick: () => void }) {
  return (
    <button className="back-button" onClick={onClick}>
      ← Back
    </button>
  );
}
function ErrorBanner({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  return (
    <div className="global-error">
      <AlertTriangle size={16} />
      {value}
      <button onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
function LoadFailure({ value }: { value: string }) {
  return (
    <div className="run-load-failure">
      <AlertTriangle size={24} />
      <h1>Data unavailable</h1>
      <p>{value}</p>
    </div>
  );
}
function AccountView({ userEmail }: { userEmail: string }) {
  return (
    <>
      <PageTitle
        eyebrow="ACCOUNT"
        title="Your account"
        copy="Your identity and access are managed securely for this workspace."
      />
      <section className="panel">
        <Fact title={userEmail} detail="Current authenticated account" state="active" />
      </section>
    </>
  );
}
function isTerminal(state: string) {
  return ["passed", "failed", "cancelled", "infrastructure_error"].includes(state);
}
function human(value: string) {
  return value.replaceAll("_", " ");
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function dashboardView(
  path: string,
): "overview" | "missions" | "runs" | "reports" | "settings" | "integrations" | "account" {
  if (path.startsWith("/dashboard/missions")) return "missions";
  if (path.startsWith("/dashboard/runs")) return "runs";
  if (path.startsWith("/dashboard/reports")) return "reports";
  if (path.startsWith("/dashboard/settings")) return "settings";
  if (path.startsWith("/dashboard/integrations")) return "integrations";
  if (path.startsWith("/dashboard/account")) return "account";
  return "overview";
}
