import { AlertTriangle } from "lucide-react";
import {
  OverviewSurface,
  RunCollectionSurface,
  RunDetailSurface,
  AccountSurface,
} from "./product-design/ProductSurfaces.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

import { Integrations } from "../features/settings/integrations.js";
import { api, type Project } from "../infrastructure/api/index.js";
import { PageSkeleton } from "../shared/components/index.js";
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
import { reportNarrative, type EvidenceSelection } from "./ReportNarrative.js";
import { MissionCollection } from "./MissionCollection.js";
import { MissionTestResources } from "./MissionTestResources.js";
import {
  MissionDetailDesign,
  JourneyEvidenceDesign,
  ReportCollectionDesign,
  ReportDetailDesign,
} from "./TestingWorkspace.js";

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
  }>;
  flows: Array<{ id: string; name: string; purpose: string; state: string; revision: number }>;
  runs: Array<{
    id: string;
    flowId: string;
    objectiveId: string;
    state: string;
  }>;
};

type Run = {
  id: string;
  missionId: string;
  objectiveId: string;
  flowId: string;
  flowName: string;
  state: string;
  environmentName: string;
  baseOrigin: string;
  artifactCount: number;
  completeEvidenceStreams: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type RunDetail = Run & {
  projectId: string;
  flowPurpose: string;
  evidence: Array<{
    id: string;
    state: string;
    closureIssue?: string;
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
              key={projectId}
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/missions/${id}`)}
            />
          ) : view === "runs" ? (
            <RunList
              key={projectId}
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/runs/${id}`)}
            />
          ) : view === "reports" ? (
            <ReportList
              key={projectId}
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/reports/${id}`)}
            />
          ) : (
            <Overview key={projectId} projectId={projectId} onNavigate={navigate} />
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
    <OverviewSurface
      missions={data.missions}
      runs={data.runs}
      reportCount={data.reports.length}
      onMission={(id) => onNavigate(`/dashboard/missions/${id}`)}
      onRun={(id) => onNavigate(`/dashboard/runs/${id}`)}
      onMissions={() => onNavigate("/dashboard/missions")}
      onRuns={() => onNavigate("/dashboard/runs")}
      onReports={() => onNavigate("/dashboard/reports")}
      onIntegrations={() => onNavigate("/dashboard/integrations")}
    />
  );
}

function MissionList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const navigate = useNavigate();
  const state = useResource<Mission[]>(`/projects/${projectId}/missions`);
  return (
    <MissionCollection
      missions={state.data ?? []}
      state={state.error ? "error" : state.data ? "ready" : "loading"}
      onOpen={onOpen}
      onIntegrations={() => navigate("/dashboard/integrations")}
      onRetry={state.reload}
    />
  );
}

function RunList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const navigate = useNavigate();
  const state = useResource<Run[]>(`/projects/${projectId}/runs`, 2_000);
  return (
    <RunCollectionSurface
      runs={state.data ?? []}
      state={state.error ? "error" : state.data ? "ready" : "loading"}
      onOpen={onOpen}
      onRetry={state.reload}
      onMissions={() => navigate("/dashboard/missions")}
    />
  );
}

function ReportList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const navigate = useNavigate();
  const state = useResource<Report[]>(`/projects/${projectId}/reports`);
  return (
    <ReportCollectionDesign
      reports={state.data ?? []}
      state={state.error ? "error" : state.data ? "ready" : "loading"}
      onOpen={onOpen}
      onMissions={() => navigate("/dashboard/missions")}
      onRetry={state.reload}
    />
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
  const state = useResource<MissionDetail>(`/dashboard/missions/${missionId}`, 2_000);
  useResourceProject(state.data?.projectId, onProjectResolved);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const mission = state.data;
  return (
    <MissionDetailDesign
      mission={mission}
      onBack={onBack}
      {...(mission.finalReportId
        ? { onReport: () => navigate(`/dashboard/reports/${mission.finalReportId}`) }
        : {})}
      journeys={
        <>
          <MissionJourneys mission={mission} />
          <MissionTestResources missionId={missionId} />
        </>
      }
    />
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
    const destination = evidenceDestination.current;
    // Keep the selected journey and attempt visible above the media when arriving from a report.
    (destination?.closest("[data-evidence-stage]") ?? destination)?.scrollIntoView({
      block: "start",
      behavior: "auto",
    });
    evidenceDestination.current?.focus({ preventScroll: true });
  }, [selection, local]);
  const request = selection ?? local;
  const selected =
    request ?? (mission.runs.at(-1) ? { runId: mission.runs.at(-1)!.id } : undefined);
  const run = mission.runs.find((r) => r.id === selected?.runId);
  const choose = (value: EvidenceSelection) => {
    setLocal(value);
    onSelect?.(value);
  };
  return (
    <JourneyEvidenceDesign
      key={mission.id}
      journeys={mission.flows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        purpose: flow.purpose,
        attempts: mission.runs
          .filter((run) => run.flowId === flow.id)
          .map((run) => ({ id: run.id, progress: attemptProgress(run.state) })),
      }))}
      {...(selected ? { selectedRunId: selected.runId } : {})}
      {...(request ? { selectionRequest: request } : {})}
      onSelect={(runId) => choose({ runId })}
      evidence={
        (run || selected) && (
          <section aria-label="Selected attempt evidence" ref={evidenceDestination} tabIndex={-1}>
            {run ? (
              <RunEvidence
                key={run.id}
                runId={run.id}
                {...(selected?.artifactId ? { initialArtifactId: selected.artifactId } : {})}
              />
            ) : (
              <p role="alert">
                That evidence reference does not belong to an available attempt in this mission.
                Choose an attempt above.
              </p>
            )}
          </section>
        )
      }
    />
  );
}

function RunDetailView({
  runId,
  onBack,
  onProjectResolved,
}: { runId: string; onBack: () => void } & ProjectResolution) {
  const navigate = useNavigate();
  const state = useResource<RunDetail>(`/runs/${runId}`, 2_000);
  useResourceProject(state.data?.projectId, onProjectResolved);
  if (state.error) return <LoadFailure value={state.error} />;
  if (!state.data) return <PageSkeleton />;
  const run = state.data;
  const notes = run.evidence.flatMap((item) =>
    item.closureIssue || item.state === "unavailable"
      ? [
          "Recording unavailable",
          "No recording is available for this attempt. Do not infer an application result from missing evidence.",
        ]
      : item.state === "complete"
        ? ["Recording saved", "The recording is available for review."]
        : [
            item.state === "incomplete" ? "Partial recording" : "Recording in progress",
            "Only the available footage can support visual review. Missing footage does not establish an application defect.",
          ],
  );
  return (
    <RunDetailSurface
      run={run}
      onBack={onBack}
      {...(run.missionId
        ? { onMission: () => navigate(`/dashboard/missions/${run.missionId}`) }
        : {})}
      evidence={<RunEvidence runId={runId} />}
      recordingNotes={[
        ...new Set(
          notes.length
            ? notes
            : [
                "No recording available yet",
                "Review the test report for what was checked and what remains unverified.",
              ],
        ),
      ]}
    />
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
    <ReportDetailDesign
      report={report}
      content={reportNarrative(report.safeReport)}
      onBack={onBack}
      onMission={() => navigate(`/dashboard/missions/${report.missionId}`)}
      onEvidence={setSelection}
      evidenceRequested={!!selection}
      evidence={
        <>
          <ReportMissionEvidence
            missionId={report.missionId}
            {...(selection ? { selection } : {})}
            onSelect={setSelection}
          />
          <MissionTestResources missionId={report.missionId} readOnly />
        </>
      }
    />
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
  const state = useResource<MissionDetail>(`/dashboard/missions/${missionId}`);
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

function useResource<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [reloadIndex, setReloadIndex] = useState(0);
  const reload = useCallback(() => {
    setData(undefined);
    setError("");
    setReloadIndex((current) => current + 1);
  }, []);
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
  }, [intervalMs, path, reloadIndex]);
  return useMemo(() => ({ data, error, reload }), [data, error, reload]);
}

function attemptProgress(state: string) {
  if (
    [
      "passed",
      "failed",
      "infrastructure_error",
      "application_failure",
      "environment_failure",
      "blocked",
      "ended",
    ].includes(state)
  )
    return "Ended";
  return human(state);
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
  return <AccountSurface email={userEmail} />;
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
