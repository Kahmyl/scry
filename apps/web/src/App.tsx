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
} from "./api.js";
import { publicConfig } from "./runtime-config.js";
import {
  deriveRecordingTimeline,
  deriveRecoveryTimeline,
  type RecordingTimelineEntry,
} from "./recording-timeline.js";
import {
  dashboardPaths as viewPaths,
  reconcileProjectSelection,
  resolveDashboardView,
  veilPolicyIdentity,
  veilTighteningOptions,
  type DashboardView as View,
} from "./dashboard-state.js";
import { MissionDetailPage, MissionReportsPage, Missions } from "./mission-observation.js";
import { MissionReportView } from "./mission-report-view.js";
import { ReportView } from "./run-report-view.js";
import { Modal, WizardSelect } from "./dashboard-controls.js";
import { AccountSettings, Integrations, Settings, WorkspaceSettings } from "./settings-views.js";
import { Flows, Overview, Runs } from "./operational-observation.js";
import { formatDuration } from "./dashboard-format.js";
import { AuthenticatedArtifact, AuthenticatedVideo, RecordingPlaylist } from "./evidence-media.js";
export { RecordingPlaylist } from "./evidence-media.js";

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

function Sidebar({
  projects,
  projectId,
  view,
  onSelectProject,
  onNavigate,
  onCreateProject,
}: {
  projects: Project[];
  projectId: string;
  view: View;
  onSelectProject: (id: string) => void;
  onNavigate: (view: View) => void;
  onCreateProject: () => void;
}) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const selectedProject = projects.find((project) => project.id === projectId);
  const nav: Array<[View, string, ReactNode]> = [
    ["overview", "Dashboard", <LayoutDashboard size={17} />],
    ["missions", "Missions", <Eye size={17} />],
    ["runs", "Runs", <Activity size={17} />],
    ["reports", "Reports", <FileText size={17} />],
  ];

  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeProjectMenu = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeProjectMenu);
    return () => document.removeEventListener("pointerdown", closeProjectMenu);
  }, [projectMenuOpen]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Eye size={21} strokeWidth={2.3} />
        </div>
        <div>
          <strong>Scry</strong>
          <span>TEST INTELLIGENCE</span>
        </div>
      </div>
      <div className="project-switcher">
        <span className="eyebrow">PROJECT</span>
        <div className="project-select" ref={projectMenuRef}>
          <button
            className="project-select-trigger"
            onClick={() => setProjectMenuOpen((open) => !open)}
            aria-expanded={projectMenuOpen}
            aria-haspopup="listbox"
          >
            <span>{selectedProject?.name ?? "No projects yet"}</span>
            <ChevronDown size={16} />
          </button>
          {projectMenuOpen && (
            <div className="project-select-menu" role="listbox" aria-label="Select project">
              <div className="project-select-heading">Switch project</div>
              <div className="project-select-options">
                {projects.length ? (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      className={project.id === projectId ? "selected" : ""}
                      onClick={() => {
                        onSelectProject(project.id);
                        setProjectMenuOpen(false);
                      }}
                      role="option"
                      aria-selected={project.id === projectId}
                    >
                      <span className="project-option-icon">
                        <Box size={15} />
                      </span>
                      <span className="project-option-copy">
                        <strong>{project.name}</strong>
                        <small>
                          {project.id === projectId ? "Current project" : "Open workspace"}
                        </small>
                      </span>
                      {project.id === projectId && <Check size={15} />}
                    </button>
                  ))
                ) : (
                  <div className="project-select-empty">
                    Create your first project to get started.
                  </div>
                )}
              </div>
              <button
                className="project-select-create"
                onClick={() => {
                  setProjectMenuOpen(false);
                  onCreateProject();
                }}
              >
                <Plus size={15} /> Create new project
              </button>
            </div>
          )}
        </div>
      </div>
      <nav>
        {nav.map(([key, label, icon]) => (
          <button
            key={key}
            className={view === key ? "nav-active" : ""}
            onClick={() => onNavigate(key)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={view === "integrations" ? "nav-active" : ""}
          onClick={() => onNavigate("integrations")}
        >
          <PlugZap size={17} /> Integrations
        </button>
        <button
          className={view === "settings" ? "nav-active" : ""}
          onClick={() => onNavigate("settings")}
        >
          <Settings2 size={17} /> Project settings
        </button>
      </div>
    </aside>
  );
}

function Topbar({
  project,
  userEmail,
  onWorkspaceSettings,
  onAccountSettings,
  onSignOut,
}: {
  project: Project | undefined;
  userEmail: string;
  onWorkspaceSettings: () => void;
  onAccountSettings: () => void;
  onSignOut?: () => void | Promise<void>;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const initials = userEmail
    .split("@")[0]!
    .split(/[._-]/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    if (!accountOpen) return;
    const closeAccountMenu = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("pointerdown", closeAccountMenu);
    return () => document.removeEventListener("pointerdown", closeAccountMenu);
  }, [accountOpen]);

  return (
    <header className="topbar">
      <div>
        <span className="crumb">Workspace</span>
        <span className="crumb-separator">/</span>
        <strong>{project?.name ?? "Scry"}</strong>
      </div>
      <div className="top-actions">
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className="avatar-button"
            onClick={() => setAccountOpen((open) => !open)}
            aria-label="Open account menu"
            aria-expanded={accountOpen}
          >
            <span className="avatar">{initials || "SC"}</span>
          </button>
          {accountOpen && (
            <div className="account-popover">
              <div className="account-identity">
                <span>Signed in as</span>
                <strong>{userEmail}</strong>
              </div>
              <div className="account-menu-actions">
                <button
                  onClick={() => {
                    setAccountOpen(false);
                    onWorkspaceSettings();
                  }}
                >
                  <Box size={15} /> Workspace settings
                </button>
                <button
                  onClick={() => {
                    setAccountOpen(false);
                    onAccountSettings();
                  }}
                >
                  <Settings2 size={15} /> Account settings
                </button>
                {onSignOut && (
                  <button className="account-logout" onClick={() => void onSignOut()}>
                    <LogOut size={15} /> Log out
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const project = await post<Project>("/projects", { name, description });
      onCreated(project);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create project"
      subtitle="Create a home for related Flows, runs, and durable test history."
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="stack-form">
        <label>
          <span>Project name</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme staging"
          />
        </label>
        <label>
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Customer-facing product journeys"
          />
        </label>
        {error && (
          <div className="form-error">
            <AlertTriangle size={15} /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-workspace">
      <div className="radar large">
        <span />
        <span />
        <span />
        <Eye size={38} />
      </div>
      <div className="eyebrow lime">WELCOME TO SCRY</div>
      <h1>
        Give every test
        <br />a permanent memory.
      </h1>
      <p>
        Create a project, then build connected Flows with their own related URLs, ordered Sequences,
        and durable browser evidence.
      </p>
      <button className="primary-button" onClick={onCreate}>
        <Plus size={16} /> Create first project
      </button>
    </div>
  );
}
function BootScreen() {
  return (
    <div className="boot">
      <div className="brand-mark">
        <Eye size={25} />
      </div>
      <div className="boot-line">
        <span />
      </div>
      <small>INITIALIZING TEST COMMAND</small>
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
