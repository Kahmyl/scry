import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  Gauge,
  Image,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  Network,
  PlugZap,
  Copy,
  Play,
  Plus,
  ScanSearch,
  Search,
  Settings2,
  ShieldCheck,
  LogOut,
  Square,
  TerminalSquare,
  Trash2,
  X,
  XCircle,
  Wrench,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

import {
  BootScreen,
  CreateProjectDialog,
  EmptyWorkspace,
  Sidebar,
  Topbar,
} from "./components/index.js";

import {
  api,
  patch,
  post,
  remove,
  type Credential,
  type Calibration,
  type CredentialIncident,
  type Environment,
  type VeilPreferenceRecord,
  type McpAccessToken,
  type MissionDetail,
  type MissionReport,
  type MissionSummary,
  type Project,
  type Report,
  type Run,
  type RunState,
  type Flow,
} from "../infrastructure/api/index.js";
import { publicConfig } from "../infrastructure/config/index.js";
import {
  deriveRecordingTimeline,
  deriveRecoveryTimeline,
  type RecordingTimelineEntry,
} from "../features/runs/index.js";
import {
  dashboardPaths as viewPaths,
  reconcileProjectSelection,
  resolveDashboardView,
  veilPolicyIdentity,
  veilTighteningOptions,
  type DashboardView as View,
} from "../shared/state/index.js";
import { MissionDetailPage, MissionReportsPage, Missions } from "../features/missions/index.js";
import { MissionReportView } from "../features/missions/index.js";
import { ReportView } from "../features/runs/index.js";
import { Modal, WizardSelect } from "../shared/components/index.js";
import {
  AccountSettings,
  Integrations,
  Settings,
  WorkspaceSettings,
} from "../features/settings/index.js";
import { Flows, Overview, Runs } from "../features/operations/index.js";
import { formatDuration } from "../shared/format/index.js";
import {
  AuthenticatedArtifact,
  AuthenticatedVideo,
  RecordingPlaylist,
} from "../features/evidence/index.js";
export { RecordingPlaylist } from "../features/evidence/index.js";

export function App({
  userEmail = "hello@scry.dev",
  onSignOut,
}: {
  userEmail?: string;
  onSignOut?: () => void | Promise<void>;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem("scry:project") ?? "");
  const [loading, setLoading] = useState(true);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const reportMatch = matchPath("/dashboard/reports/:reportId", location.pathname);
  const reportId = reportMatch?.params.reportId;
  const runMatch = matchPath("/dashboard/runs/:runId", location.pathname);
  const runId = runMatch?.params.runId;
  const missionFlowsMatch = matchPath("/dashboard/missions/:missionId/flows", location.pathname);
  const missionMatch =
    missionFlowsMatch ?? matchPath("/dashboard/missions/:missionId", location.pathname);
  const missionId = missionMatch?.params.missionId;
  const view = resolveDashboardView(location.pathname);

  useEffect(() => {
    if (location.pathname === "/dashboard/flows") navigate(viewPaths.missions, { replace: true });
  }, [location.pathname, navigate]);

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

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const selectProject = (id: string) => {
    setProjectId(id);
    localStorage.setItem("scry:project", id);
    navigate(viewPaths.overview);
  };

  if (loading) return <BootScreen />;

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        projectId={projectId}
        view={view}
        onSelectProject={selectProject}
        onNavigate={(next) => navigate(viewPaths[next])}
        onCreateProject={() => setCreateProjectOpen(true)}
      />
      <main className="main-stage">
        <Topbar
          project={projects.find((project) => project.id === projectId)}
          userEmail={userEmail}
          onWorkspaceSettings={() => navigate(viewPaths.workspace)}
          onAccountSettings={() => navigate(viewPaths.account)}
          {...(onSignOut ? { onSignOut } : {})}
        />
        {error && (
          <div className="global-error">
            <AlertTriangle size={16} /> {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}
        <div className="page-wrap">
          {view === "account" ? (
            <AccountSettings userEmail={userEmail} />
          ) : view === "integrations" ? (
            <Integrations />
          ) : view === "workspace" ? (
            <WorkspaceSettings userEmail={userEmail} projects={projects} />
          ) : !projectId ? (
            <EmptyWorkspace onCreate={() => setCreateProjectOpen(true)} />
          ) : reportId ? (
            <MissionReportView reportId={reportId} onBack={() => navigate(viewPaths.reports)} />
          ) : runId ? (
            <ReportView
              runId={runId}
              onBack={() => navigate(viewPaths.runs)}
              onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)}
            />
          ) : missionId && missionFlowsMatch ? (
            <Flows
              projectId={projectId}
              scopedMissionId={missionId}
              onBack={() => navigate(`/dashboard/missions/${missionId}`)}
            />
          ) : missionId ? (
            <MissionDetailPage
              missionId={missionId}
              onBack={() => navigate(viewPaths.missions)}
              onOpenFlows={() => navigate(`/dashboard/missions/${missionId}/flows`)}
              onOpenRun={(id) => navigate(`/dashboard/runs/${id}`)}
              onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)}
            />
          ) : view === "missions" ? (
            <Missions
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/missions/${id}`)}
            />
          ) : view === "overview" ? (
            <Overview
              projectId={projectId}
              onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)}
              onNavigate={(next) => navigate(viewPaths[next])}
            />
          ) : view === "runs" ? (
            <Runs projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)} />
          ) : view === "reports" ? (
            <MissionReportsPage
              projectId={projectId}
              onOpen={(id) => navigate(`/dashboard/reports/${id}`)}
            />
          ) : view === "settings" ? (
            <Settings projectId={projectId} />
          ) : (
            <Overview
              projectId={projectId}
              onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)}
              onNavigate={(next) => navigate(viewPaths[next])}
            />
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

function humanState(state: string) {
  return state.replaceAll("_", " ");
}
function canonicalOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
