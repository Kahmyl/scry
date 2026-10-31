import { Activity, AlertTriangle, ArrowRight, Eye, FileText, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ReportNarrative, type EvidenceSelection } from "./ReportNarrative.js";

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
  projectId: string;
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
    conclusion?: string | null;
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
  projectId: string;
  runtimeAdapter?: "legacy" | "playwright_mcp";
  activity?: Array<{
    id: string;
    tool: string;
    state: string;
    execution?: string;
    businessOutcome?: string;
    observation?: string;
    errorCode?: string;
  }>;
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
  projectId: string;
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
  const resolveResourceProject = useCallback(
    (id: string) => {
      // Only the authorized resource response can select its project, and only
      // among this workspace's loaded projects. Never trust a guessed route ID.
      if (!projects.some((project) => project.id === id)) return;
      setProjectId(id);
      localStorage.setItem("scry:project", id);
    },
    [projects],
  );

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
            <ReportDetail
              key={reportId}
              reportId={reportId}
              onProjectResolved={resolveResourceProject}
              onBack={() => navigate("/dashboard/reports")}
            />
          ) : runId ? (
            <RunDetailView
              key={runId}
              runId={runId}
              onProjectResolved={resolveResourceProject}
              onBack={() => navigate("/dashboard/runs")}
            />
          ) : missionId ? (
            <MissionDetailView
              key={missionId}
              missionId={missionId}
              onProjectResolved={resolveResourceProject}
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

type ProjectResolution = { onProjectResolved: (projectId: string) => void };
function useResourceProject(
  projectId: string | undefined,
  onResolved: ProjectResolution["onProjectResolved"],
) {
  useEffect(() => {
    if (projectId) onResolved(projectId);
  }, [projectId, onResolved]);
}
function MissionDetailView({
  missionId,
  onBack,
  onProjectResolved,
}: { missionId: string; onBack: () => void } & ProjectResolution) {
  const navigate = useNavigate();
  const state = useResource<MissionDetail>(`/missions/${missionId}`, 2_000);
  useResourceProject(state.data?.projectId, onProjectResolved);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const mission = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle
        eyebrow="MISSION"
        title={mission.title}
        copy="Review progress, test journeys and their supporting evidence."
      />
      {mission.finalReportId && (
        <button
          className="primary-button"
          onClick={() => navigate(`/dashboard/reports/${mission.finalReportId}`)}
        >
          View test report <ArrowRight size={16} />
        </button>
      )}
      <details className="panel">
        <summary>Original request</summary>
        <p>{mission.instruction}</p>
      </details>
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
      </section>
      <MissionJourneys mission={mission} />
    </>
  );
}

function MissionJourneys({
  mission,
  selection,
  onSelect,
}: {
  mission: MissionDetail;
  selection?: EvidenceSelection;
  onSelect?: (selection: EvidenceSelection) => void;
}) {
  const [local, setLocal] = useState<EvidenceSelection>();
  const evidenceDestination = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selection && !local) return;
    evidenceDestination.current?.scrollIntoView({ block: "start", behavior: "auto" });
    evidenceDestination.current?.focus({ preventScroll: true });
  }, [selection, local]);
  const selected =
    selection ?? local ?? (mission.runs.at(-1) ? { runId: mission.runs.at(-1)!.id } : undefined);
  const run = mission.runs.find((r) => r.id === selected?.runId),
    flow = mission.flows.find((f) => f.id === run?.flowId);
  const choose = (value: EvidenceSelection) => {
    setLocal(value);
    onSelect?.(value);
  };
  return (
    <section className="mission-journeys" aria-label="Mission test journeys">
      <h2>Test journeys</h2>
      <p>
        Flows are directions within this mission. Each run is an attempt; earlier failures and
        recovery attempts remain visible.
      </p>
      {mission.flows.map((flow) => (
        <section className="panel" key={flow.id}>
          <h3>{flow.name}</h3>
          {flow.purpose && <p>{flow.purpose}</p>}
          {mission.runs
            .filter((r) => r.flowId === flow.id)
            .map((run, index) => (
              <div className="journey-attempt" key={run.id}>
                <button
                  aria-pressed={selected?.runId === run.id}
                  onClick={() => choose({ runId: run.id })}
                >
                  Attempt {index + 1} · {human(run.outcomeClassification ?? run.state)}
                </button>
                <p>
                  {run.conclusion ??
                    (["passed", "failed", "cancelled", "infrastructure_error"].includes(run.state)
                      ? "This historical attempt has no separately recorded conclusion."
                      : "This attempt is still in progress.")}
                </p>
              </div>
            ))}
          {!mission.runs.some((r) => r.flowId === flow.id) && (
            <p>No attempts have started for this journey.</p>
          )}
        </section>
      ))}
      {!mission.flows.length && <p>No test journeys have been created yet.</p>}
      {(run || selected) && (
        <section aria-label="Selected attempt evidence" ref={evidenceDestination} tabIndex={-1}>
          {run ? (
            <>
              <h3>
                {flow?.name ?? "Selected test journey"} · Attempt{" "}
                {mission.runs
                  .filter((r) => r.flowId === run.flowId)
                  .findIndex((r) => r.id === run.id) + 1}
              </h3>
              <RunEvidence
                key={run.id}
                runId={run.id}
                {...(selected?.artifactId ? { initialArtifactId: selected.artifactId } : {})}
              />
            </>
          ) : (
            <p role="alert">
              That evidence reference does not belong to an available attempt in this mission.
              Choose an attempt above.
            </p>
          )}
        </section>
      )}
    </section>
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
function RunDetailView({
  runId,
  onBack,
  onProjectResolved,
}: { runId: string; onBack: () => void } & ProjectResolution) {
  const state = useResource<RunDetail>(`/runs/${runId}`, 2_000);
  useResourceProject(state.data?.projectId, onProjectResolved);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const run = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle
        eyebrow="RUN ATTEMPT"
        title={run.flowName}
        copy={`${run.environmentName} · ${run.baseOrigin}`}
      />
      <section className="metric-grid metric-grid-compact">
        <Metric label="State" value={human(run.state)} state={run.state} />
        {run.runtimeAdapter === "playwright_mcp" ? (
          <Metric label="Browser interactions" value={String(run.activity?.length ?? 0)} />
        ) : (
          <>
            <Metric
              label="Authentication effects"
              value={`${run.authenticationCommitsUsed}/${run.authenticationCommitLimit}`}
            />
            <Metric
              label="Business effects"
              value={`${run.businessCommitsUsed}/${run.businessCommitLimit}`}
            />
          </>
        )}
      </section>
      {run.runtimeAdapter === "playwright_mcp" ? (
        <details className="panel">
          <summary>Browser activity · {run.activity?.length ?? 0} interactions</summary>
          <p>
            A completed interaction means the browser tool returned. Verify application outcomes
            using the observations and evidence; an uncertain action must not be repeated blindly.
          </p>
          {(run.activity ?? []).map((action) => (
            <Fact
              key={action.id}
              title={human(action.tool.replace(/^browser_/u, ""))}
              detail={`Execution ${human(action.execution ?? action.state)} · observation ${human(action.observation ?? "unavailable")}${action.errorCode ? ` · ${action.errorCode}` : ""}`}
              state={action.state}
            />
          ))}
          {!run.activity?.length && <p>No browser interactions have been recorded yet.</p>}
        </details>
      ) : (
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
      )}
      <RunEvidence runId={runId} />
      <section className="panel">
        <ListHeading title="Recording status" />
        {run.evidence.map((item) => (
          <Fact
            key={item.id}
            title={
              item.closureIssue
                ? item.closureIssue === "video_unavailable"
                  ? "Video unavailable"
                  : "Recording unavailable"
                : item.state === "complete"
                  ? "Recording saved"
                  : item.state === "incomplete"
                    ? "Partial recording"
                    : "Recording in progress"
            }
            detail={
              item.closureIssue
                ? (evidenceIssueMessages[item.closureIssue] ??
                  "This recording is unavailable. Scry has not published unverifiable evidence.")
                : `${item.state === "complete" ? "The captured evidence was saved for review." : "Review the available evidence and any gaps before relying on this attempt."}${item.interruptions ? ` ${item.interruptions} recording interruption${item.interruptions === 1 ? "" : "s"}; this is not a complete recording.` : ""}${item.state === "incomplete" && !item.chunkCount ? " Recording unavailable; no captured evidence was admitted." : ""}`
            }
            state={item.state}
          />
        ))}
        {!!run.evidence.length && (
          <details>
            <summary>Technical evidence details</summary>
            {run.evidence.map((item) => (
              <p key={item.id}>
                {item.chunkCount} admitted chunks · {item.totalBytes} bytes · chain{" "}
                {item.chainHead ?? "unavailable"}
              </p>
            ))}
          </details>
        )}
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

function ReportDetail({
  reportId,
  onBack,
  onProjectResolved,
}: { reportId: string; onBack: () => void } & ProjectResolution) {
  const navigate = useNavigate();
  const [selection, setSelection] = useState<EvidenceSelection>();
  const state = useResource<Report>(`/reports/${reportId}`);
  useResourceProject(state.data?.projectId, onProjectResolved);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const report = state.data;
  return (
    <>
      <Back onClick={onBack} />
      <PageTitle eyebrow="FINAL MISSION REPORT" title={report.missionTitle} copy={report.summary} />
      <button onClick={() => navigate(`/dashboard/missions/${report.missionId}`)}>
        Back to mission
      </button>
      <section className="panel">
        <ListHeading title="Recording coverage" />
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
      <ReportNarrative
        {...(report.safeReport ? { value: report.safeReport } : {})}
        onEvidence={setSelection}
      />
      <ReportMissionEvidence
        missionId={report.missionId}
        {...(selection ? { selection } : {})}
        onSelect={setSelection}
      />
      <details className="panel">
        <summary>Technical details and original report data</summary>
        <Fact title="Evidence reference" detail={report.evidenceDigest} state={report.state} />
        <pre className="browser-safe-report">
          {JSON.stringify(report.safeReport ?? {}, null, 2)}
        </pre>
      </details>
    </>
  );
}
function ReportMissionEvidence({
  missionId,
  selection,
  onSelect,
}: {
  missionId: string;
  selection?: EvidenceSelection;
  onSelect: (selection: EvidenceSelection) => void;
}) {
  const state = useResource<MissionDetail>(`/missions/${missionId}`);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <p role="status">Loading mission attempts and evidence…</p>;
  return (
    <MissionJourneys
      mission={state.data}
      {...(selection ? { selection } : {})}
      onSelect={onSelect}
    />
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
