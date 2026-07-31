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
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  LogOut,
  Square,
  TerminalSquare,
  TestTube2,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

import {
  api,
  apiBlob,
  patch,
  post,
  remove,
  type Credential,
  type Environment,
  type McpAccessToken,
  type Project,
  type Report,
  type Run,
  type RunState,
  type Specification,
} from "./api.js";
import { publicConfig } from "./runtime-config.js";

type View = "overview" | "specifications" | "runs" | "reports" | "settings" | "workspace" | "account" | "integrations";
type SequenceActionType = "navigate" | "fill" | "click" | "waitFor" | "screenshot";
type VerificationDraft = {
  id: string;
  type: "visible" | "hidden" | "url";
  value: string;
};
type SequenceDraft = {
  id: string;
  type: SequenceActionType;
  title: string;
  url: string;
  targetStrategy: "role" | "label" | "placeholder" | "text" | "testId";
  targetRole: "button" | "link" | "heading" | "textbox";
  target: string;
  valueMode: "value" | "secret";
  value: string;
  verifications: VerificationDraft[];
  readinessType: "visible" | "hidden" | "url" | "content" | "request" | "settle" | "delay";
  readinessValue: string;
  readinessTimeoutMs: number;
};
const viewPaths: Record<View, string> = {
  overview: "/dashboard",
  specifications: "/dashboard/flows",
  runs: "/dashboard/runs",
  reports: "/dashboard/reports",
  settings: "/dashboard/settings",
  workspace: "/dashboard/workspace",
  account: "/dashboard/account",
  integrations: "/dashboard/integrations",
};
const terminalStates: RunState[] = [
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
];
const FLOW_PAGE_SIZE = 9;
const RUN_PAGE_SIZE = 10;

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
  const view: View =
    reportId || location.pathname === viewPaths.reports
      ? "reports"
      : location.pathname === viewPaths.specifications || location.pathname === "/dashboard/specifications"
        ? "specifications"
        : location.pathname === viewPaths.runs
          ? "runs"
          : location.pathname === viewPaths.settings
            ? "settings"
            : location.pathname === viewPaths.workspace
              ? "workspace"
            : location.pathname === viewPaths.account
              ? "account"
            : location.pathname === viewPaths.integrations
              ? "integrations"
            : "overview";

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<Project[]>("/projects");
      setProjects(data);
      if (!projectId && data[0]) {
        setProjectId(data[0].id);
        localStorage.setItem("scry:project", data[0].id);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);
  useEffect(() => {
    if (location.pathname === viewPaths.reports) {
      navigate(viewPaths.runs, { replace: true });
    }
  }, [location.pathname, navigate]);

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
            <ReportView runId={reportId} onBack={() => navigate(viewPaths.runs)} onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)} />
          ) : view === "overview" ? (
            <Overview projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)} onNavigate={(next) => navigate(viewPaths[next])} />
          ) : view === "specifications" ? (
            <Specifications projectId={projectId} onRunStarted={(id) => navigate(`/dashboard/reports/${id}`)} />
          ) : view === "runs" ? (
            <Runs projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)} />
          ) : view === "settings" ? (
            <Settings projectId={projectId} />
          ) : (
            <Overview projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/reports/${id}`)} onNavigate={(next) => navigate(viewPaths[next])} />
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
    ["overview", "Command center", <LayoutDashboard size={17} />],
    ["specifications", "Flows", <FileCode2 size={17} />],
    ["runs", "Runs", <Activity size={17} />],
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
        <div className="brand-mark"><Eye size={21} strokeWidth={2.3} /></div>
        <div><strong>Scry</strong><span>TEST INTELLIGENCE</span></div>
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
                {projects.length ? projects.map((project) => (
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
                    <span className="project-option-icon"><Box size={15} /></span>
                    <span className="project-option-copy">
                      <strong>{project.name}</strong>
                      <small>{project.id === projectId ? "Current project" : "Open workspace"}</small>
                    </span>
                    {project.id === projectId && <Check size={15} />}
                  </button>
                )) : (
                  <div className="project-select-empty">Create your first project to get started.</div>
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
            {icon}<span>{label}</span>
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
  const initials = userEmail.split("@")[0]!.split(/[._-]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

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
                <button onClick={() => {
                  setAccountOpen(false);
                  onWorkspaceSettings();
                }}>
                  <Box size={15} /> Workspace settings
                </button>
                <button onClick={() => {
                  setAccountOpen(false);
                  onAccountSettings();
                }}>
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

function Overview({
  projectId,
  onOpenReport,
  onNavigate,
}: {
  projectId: string;
  onOpenReport: (id: string) => void;
  onNavigate: (view: View) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [specs, setSpecs] = useState<Specification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      api<Run[]>(`/projects/${projectId}/runs`),
      api<Specification[]>(`/projects/${projectId}/specifications`),
    ]).then(([nextRuns, nextSpecs]) => {
      setRuns(nextRuns);
      setSpecs(nextSpecs);
      setLoading(false);
    });
  }, [projectId]);

  const passed = runs.filter((run) => run.state === "passed").length;
  const completed = runs.filter((run) => terminalStates.includes(run.state)).length;
  const passRate = completed ? Math.round((passed / completed) * 100) : 0;
  const active = runs.filter((run) =>
    ["queued", "preparing", "running", "finalizing"].includes(run.state),
  ).length;
  const failedRuns = runs.filter((run) => run.needsAttention);
  const firstRunSetup = specs.length === 0 && runs.length === 0;

  if (loading) return <PageSkeleton />;

  if (firstRunSetup) {
    return (
      <>
        <PageTitle
          eyebrow="COMMAND CENTER"
          title="Set up your first Flow"
          copy="Describe one connected journey, the related URLs it uses, and what success means."
        />
        <section className="panel onboarding-panel">
          <div className="onboarding-intro">
            <div className="onboarding-orbit"><Eye size={28} /></div>
            <div>
              <span className="eyebrow lime">GETTING STARTED</span>
              <h2>Create the journey you want to test</h2>
              <p>Add its destinations in the order they are needed. Every URL must contribute to the same connected user journey.</p>
            </div>
            <button className="primary-button onboarding-primary" onClick={() => onNavigate("specifications")}>
              Create Flow <ArrowRight size={16} />
            </button>
          </div>
          <div className="setup-journey">
            <button className="current" onClick={() => onNavigate("specifications")}>
              <span>1</span>
              <div><strong>Describe the Flow</strong><small>Name the connected journey and its purpose.</small></div>
              <ArrowRight size={16} />
            </button>
            <button onClick={() => onNavigate("specifications")}>
              <span>2</span>
              <div><strong>Build the Sequence</strong><small>Add related destinations in the order they are visited.</small></div>
              <ArrowRight size={16} />
            </button>
            <button disabled>
              <span>3</span>
              <div><strong>Run and review</strong><small>Execute in Chrome and inspect durable evidence.</small></div>
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageTitle
        eyebrow="COMMAND CENTER"
        title="Project activity"
        copy="What needs attention, what is running, and the latest evidence from this project."
        action={<button className="primary-button" onClick={() => onNavigate("specifications")}><Plus size={16} /> Create Flow</button>}
      />

      {failedRuns.length > 0 && (
        <button className="attention-banner" onClick={() => onOpenReport(failedRuns[0]!.id)}>
          <span className="attention-icon"><AlertTriangle size={19} /></span>
          <span><strong>{failedRuns.length} run{failedRuns.length === 1 ? "" : "s"} need attention</strong><small>Open the latest failure to review the cause and captured evidence.</small></span>
          <ArrowRight size={18} />
        </button>
      )}

      <section className="metric-grid metric-grid-compact">
        <Metric label="Active now" value={String(active)} detail={active ? "Queued or executing" : "Nothing currently running"} icon={<Activity />} tone="lime" />
        <Metric label="Pass rate" value={`${passRate}%`} detail={`${completed} completed runs`} icon={<Gauge />} tone="lime" />
        <Metric label="Needs attention" value={String(failedRuns.length)} detail={failedRuns.length ? "Failed or interrupted runs" : "No unresolved failures"} icon={<AlertTriangle />} />
      </section>

      <section className="content-grid">
        <div className="panel span-2">
          <PanelHeader title="Recent execution" kicker="LATEST ACTIVITY" action="View all" onAction={() => onNavigate("runs")} />
          {runs.length ? (
            <div className="run-list">
              {runs.slice(0, 6).map((run) => (
                <RunRow key={run.id} run={run} onOpen={() => onOpenReport(run.id)} />
              ))}
            </div>
          ) : (
            <EmptyBlock icon={<Activity />} title="No runs yet" copy="Create a Flow and launch its first controlled browser journey." />
          )}
        </div>
        <div className="panel">
          <PanelHeader title="Flow coverage" kicker={`${specs.length} FLOWS`} action="Manage" onAction={() => onNavigate("specifications")} />
          <div className="coverage-list">
            {specs.slice(0, 5).map((spec, index) => (
              <div key={spec.id}>
                <span className="coverage-index">{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{spec.name}</strong><span>{spec.latestPlan?.steps.length ?? 0} planned actions</span></div>
                {spec.latestPlanVersionId ? <Check size={15} /> : <Clock3 size={15} />}
              </div>
            ))}
            {!specs.length && <EmptyBlock icon={<FileCode2 />} title="No coverage yet" copy="Your reusable journeys will appear here." />}
          </div>
        </div>
      </section>
    </>
  );
}

function Specifications({ projectId, onRunStarted }: { projectId: string; onRunStarted: (id: string) => void }) {
  const [specs, setSpecs] = useState<Specification[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [dialog, setDialog] = useState<Specification | "new" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [starting, setStarting] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    void Promise.all([
      api<Specification[]>(`/projects/${projectId}/specifications`),
      api<Environment[]>(`/projects/${projectId}/environments`),
      api<Credential[]>(`/projects/${projectId}/credentials`),
    ]).then(([s, e, c]) => {
      setSpecs(s);
      setEnvironments(e);
      setCredentials(c);
    });
  }, [projectId, refresh]);

  const visibleSpecs = specs.filter((spec) => {
    const searchable = `${spec.name} ${spec.latestContent?.objective ?? spec.description}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase());
  });
  const pageCount = Math.max(1, Math.ceil(visibleSpecs.length / FLOW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSpecs = visibleSpecs.slice((currentPage - 1) * FLOW_PAGE_SIZE, currentPage * FLOW_PAGE_SIZE);

  useEffect(() => setPage(1), [projectId, query]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  const runSpecification = async (specification: Specification) => {
    const environment =
      environments.find((item) => item.name === `flow:${specification.id}`) ??
      environments.find((item) => !item.name.startsWith("flow:"));
    if (!environment || !specification.latestPlanVersionId) return;
    setStarting(specification.id);
    setError("");
    try {
      const run = await post<{ id: string }>(`/projects/${projectId}/runs`, {
        environmentId: environment.id,
        planVersionId: specification.latestPlanVersionId,
        browser: "chromium",
        viewport: { width: 1280, height: 720 },
        seed: 1,
      });
      await post(`/runs/${run.id}/start`);
      onRunStarted(run.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setStarting("");
    }
  };

  return (
    <>
      <PageTitle
        eyebrow="FLOW LIBRARY"
        title="Flows"
        copy="Reusable user journeys, ordered Sequences, and expected outcomes."
        action={<button className="primary-button" onClick={() => setDialog("new")}><Plus size={16} /> New Flow</button>}
      />
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Flows…" /></div>
        <div className="toolbar-meta">{query ? `${visibleSpecs.length} of ` : ""}{specs.length} total</div>
      </div>
      {error && <div className="form-error page-form-error"><AlertTriangle size={15} /> {error}</div>}
      <div className="spec-grid">
        {pagedSpecs.map((spec) => (
          <article className="spec-card" key={spec.id}>
            <div className="spec-top">
              <div className="spec-icon"><Code2 size={19} /></div>
              <span className={spec.latestPlanVersionId ? "ready-tag" : "draft-tag"}>
                {spec.latestPlanVersionId ? "Executable" : "Draft"}
              </span>
            </div>
            <h3>{spec.name}</h3>
            <p title={spec.latestContent?.objective ?? (spec.description || "No objective added yet.")}>{spec.latestContent?.objective ?? (spec.description || "No objective added yet.")}</p>
            <div className="spec-facts">
              <span><FileCode2 size={14} /> v{spec.latestVersion ?? "—"}</span>
              <span><Activity size={14} /> {spec.latestPlan?.steps.length ?? 0} actions</span>
              <span><Network size={14} /> {spec.latestPlan?.steps.filter((item) => item.action?.type === "navigate").length ?? 0} destinations</span>
            </div>
            <div className="spec-footer spec-footer-actions">
              <span>{spec.latestContent?.expectedOutcomes?.length ?? 0} proof checks</span>
              <div>
                <button className="flow-edit-button" onClick={() => setDialog(spec)} title="Edit Flow">
                  <Pencil size={14} /> Edit
                </button>
                <button
                  className="flow-run-button"
                  onClick={() => void runSpecification(spec)}
                  disabled={!spec.latestPlanVersionId || !environmentFor(spec, environments) || !!starting}
                  title={!environmentFor(spec, environments) ? "This Flow needs a valid Sequence" : !spec.latestPlanVersionId ? "This Flow needs an executable Sequence" : "Run Flow"}
                >
                  {starting === spec.id ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} Run
                </button>
              </div>
            </div>
          </article>
        ))}
        {!visibleSpecs.length && (
          <div className="panel empty-large">
            <EmptyBlock icon={<FileCode2 />} title={specs.length ? "No matching Flows" : "Build your first Flow"} copy={specs.length ? "Try a different name or objective." : "Describe the journey, add its Sequence, and define the expected behavior."} />
          </div>
        )}
      </div>
      <Pagination page={currentPage} pageSize={FLOW_PAGE_SIZE} total={visibleSpecs.length} itemName="Flows" onChange={setPage} />
      {dialog && (
        <SpecDialog
          projectId={projectId}
          specification={dialog === "new" ? undefined : dialog}
          environment={dialog === "new" ? undefined : environmentFor(dialog, environments)}
          credentials={credentials}
          onCredentialCreated={(credential) => setCredentials((items) => [...items, credential].sort((a, b) => a.name.localeCompare(b.name)))}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

function Runs({
  projectId,
  onOpenReport,
}: {
  projectId: string;
  onOpenReport: (id: string) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    void api<Run[]>(`/projects/${projectId}/runs`).then(setRuns);
  }, [projectId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2_000);
    return () => clearInterval(timer);
  }, [load]);

  const visible = runs.filter((run) => {
    if (filter === "running" && !["queued", "preparing", "running", "finalizing"].includes(run.state)) return false;
    if (filter === "attention" && !run.needsAttention) return false;
    if (!["all", "running", "attention"].includes(filter) && run.state !== filter) return false;
    return (run.planName ?? "").toLowerCase().includes(query.toLowerCase());
  });
  const activeCount = runs.filter((run) => ["queued", "preparing", "running", "finalizing"].includes(run.state)).length;
  const failedCount = runs.filter((run) => run.needsAttention).length;
  const passedCount = runs.filter((run) => run.state === "passed").length;
  const pageCount = Math.max(1, Math.ceil(visible.length / RUN_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedRuns = visible.slice((currentPage - 1) * RUN_PAGE_SIZE, currentPage * RUN_PAGE_SIZE);

  useEffect(() => setPage(1), [projectId, filter, query]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  return (
    <>
      <PageTitle
        eyebrow="EXECUTION HISTORY"
        title="Runs"
        copy="Active executions, historical outcomes, and their durable evidence reports."
      />
      <div className="run-summary">
        <button className={filter === "running" ? "selected" : ""} onClick={() => setFilter(filter === "running" ? "all" : "running")}><Activity size={16} /><span>Active</span><strong>{activeCount}</strong></button>
        <button className={filter === "attention" ? "selected attention" : "attention"} onClick={() => setFilter(filter === "attention" ? "all" : "attention")}><AlertTriangle size={16} /><span>Needs attention</span><strong>{failedCount}</strong></button>
        <button className={filter === "passed" ? "selected" : ""} onClick={() => setFilter(filter === "passed" ? "all" : "passed")}><CheckCircle2 size={16} /><span>Passed</span><strong>{passedCount}</strong></button>
      </div>
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by plan…" /></div>
        <div className="filter-pills">
          {["all", "running", "passed", "attention"].map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={filter === value ? "selected" : ""}>{value}</button>
          ))}
        </div>
      </div>
      <div className="panel table-panel">
        <div className="run-table header">
          <span>Flow</span><span>Run settings</span><span>Started</span><span>Status</span><span />
        </div>
        {pagedRuns.map((run) => (
          <button className="run-table row" key={run.id} onClick={() => onOpenReport(run.id)}>
            <span><strong>{run.planName || "Untitled plan"}</strong><small>#{run.id.slice(0, 8)} · attempt {run.attemptCount || "—"}</small></span>
            <span><strong>Flow destinations</strong><small>{run.executionSnapshot?.viewport?.width} × {run.executionSnapshot?.viewport?.height}</small></span>
            <span>{relativeTime(run.createdAt)}</span>
            <StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} />
            <ArrowRight size={16} />
          </button>
        ))}
        {!visible.length && <EmptyBlock icon={<Activity />} title="No matching runs" copy="Runs will appear as soon as a plan is submitted to the execution queue." />}
        <Pagination page={currentPage} pageSize={RUN_PAGE_SIZE} total={visible.length} itemName="runs" onChange={setPage} />
      </div>
    </>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  itemName,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  itemName: string;
  onChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav className="pagination" aria-label={`${itemName} pagination`}>
      <span>Showing {first}–{last} of {total} {itemName}</span>
      <div>
        <button type="button" onClick={() => onChange(page - 1)} disabled={page === 1} aria-label={`Previous ${itemName} page`}><ChevronLeft size={15} /></button>
        <strong>Page {page} of {pageCount}</strong>
        <button type="button" onClick={() => onChange(page + 1)} disabled={page === pageCount} aria-label={`Next ${itemName} page`}><ChevronRight size={15} /></button>
      </div>
    </nav>
  );
}

function ReportView({ runId, onBack, onOpenReport }: { runId: string; onBack: () => void; onOpenReport: (id: string) => void }) {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<Report>(`/runs/${runId}/report`).then(setReport).catch((cause) => setError(message(cause)));
  }, [runId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!report || !terminalStates.includes(report.run.state)) load();
    }, 1_500);
    return () => clearInterval(timer);
  }, [load, report]);

  if (!report) return <PageSkeleton />;
  const run = report.run;
  const currentAttempt = report.attempts.at(-1);
  const passed = report.assertions.filter((assertion) => assertion.status === "passed").length;
  const failed = report.assertions.filter((assertion) => assertion.status === "failed").length;
  const screenshots = report.artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.status === "available");
  const videos = report.artifacts.filter((artifact) => artifact.kind === "video" && artifact.status === "available");
  const visuallyRedacted = report.artifacts.some((artifact) => artifact.observation?.visualRedaction === "protected-elements-masked");
  const diagnostics = report.events.filter((event) => event.type.startsWith("diagnostic."));
  const policyEvents = report.events.filter((event) => event.type === "policy.rejected");
  const fatalPolicy = [...policyEvents].reverse().find((event) => event.payload.disposition !== "blocked_subresource");
  const failedAssertion = report.assertions.find((assertion) => assertion.status === "failed");
  const failedStep = report.events.find((event) => event.type === "step.failed");
  const failureMessage = fatalPolicy
    ? `${String(fatalPolicy.payload.message ?? "Request blocked by execution policy")}${fatalPolicy.payload.target ? ` · ${String(fatalPolicy.payload.target)}` : ""}`
    : currentAttempt?.error
    ?? failedAssertion?.error
    ?? (failedStep?.payload.error ? String(failedStep.payload.error) : undefined);
  const classification = run.outcomeClassification;
  const classificationSummary = outcomeSummary(classification, failureMessage);
  const duration = currentAttempt?.startedAt && currentAttempt.completedAt
    ? new Date(currentAttempt.completedAt).getTime() - new Date(currentAttempt.startedAt).getTime()
    : undefined;

  const mutate = async (kind: "rerun" | "cancel") => {
    setBusy(kind);
    setError("");
    try {
      if (kind === "rerun") {
        const next = await post<{ id: string }>(`/runs/${runId}/rerun`);
        onOpenReport(next.id);
      } else {
        await post(`/runs/${runId}/cancel`);
        load();
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <button className="back-button" onClick={onBack}>← Back to runs</button>
      <section className={`report-hero report-${run.state}`}>
        <div className="outcome-icon">{stateIcon(run.state, 26)}</div>
        <div className="report-heading">
          <div className="eyebrow">RUN #{run.id.slice(0, 8)}</div>
          <h1>{run.planSnapshot.name}</h1>
          <p>{run.planSnapshot.objective}</p>
        </div>
        <div className="report-actions">
          {!terminalStates.includes(run.state) && (
            <button className="secondary-button danger" onClick={() => void mutate("cancel")} disabled={!!busy}>
              <Square size={14} /> Cancel
            </button>
          )}
          <button
            className="primary-button"
            onClick={() => void mutate("rerun")}
            disabled={!!busy || !terminalStates.includes(run.state)}
            title="Creates a new immutable run. A successful rerun resolves earlier failures in this rerun chain."
          >
            {busy === "rerun" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />} Rerun exact plan
          </button>
        </div>
      </section>
      {error && <div className="global-error"><AlertTriangle size={16} /> {error}</div>}
      {visuallyRedacted && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><ShieldCheck size={22} /></div>
          <div>
            <span className="eyebrow">PROTECTED EVIDENCE</span>
            <h2>Sensitive values are blacked out in visual artifacts</h2>
            <p>The run remains fully recorded, while credential fields and one-time secret reveal intervals are masked. Textual artifacts are separately redacted.</p>
          </div>
        </section>
      )}
      {run.resolvedAt && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><CheckCircle2 size={22} /></div>
          <div>
            <span className="eyebrow">RESOLVED</span>
            <h2>A later exact rerun passed</h2>
            <p>This historical result remains unchanged for auditability, but it no longer needs attention.</p>
          </div>
          {run.resolvedByRunId && (
            <button className="secondary-button" onClick={() => onOpenReport(run.resolvedByRunId!)}>
              Open passing run <ArrowRight size={15} />
            </button>
          )}
        </section>
      )}
      {run.confirmationRunId && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><LoaderCircle className="spin" size={22} /></div>
          <div><span className="eyebrow">CONFIRMATION</span><h2>A timing-controlled confirmation run is available</h2><p>The original observation remains unchanged. Open the linked run before making a product-level conclusion.</p></div>
          <button className="secondary-button" onClick={() => onOpenReport(run.confirmationRunId!)}>Open confirmation <ArrowRight size={15} /></button>
        </section>
      )}
      {run.confirmationOfRunId && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><Clock3 size={22} /></div>
          <div><span className="eyebrow">CONFIRMATION RUN</span><h2>This run rechecks a timing-sensitive observation</h2><p>The original evidence remains available and is never replaced by this result.</p></div>
          <button className="secondary-button" onClick={() => onOpenReport(run.confirmationOfRunId!)}>Open original <ArrowRight size={15} /></button>
        </section>
      )}
      {["failed", "timed_out", "infrastructure_error"].includes(run.state) && !run.resolvedAt && (
        <section className="failure-summary">
          <div className="failure-summary-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="eyebrow">WHAT NEEDS ATTENTION</span>
            <h2>{classificationSummary.title}</h2>
            <p>{classificationSummary.copy}</p>
          </div>
        </section>
      )}

      <section className="report-metrics">
        <div><span>Outcome</span><StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} /></div>
        <div><span>Assertions</span><strong>{passed}<small> passed</small>{failed > 0 && <em>{failed} failed</em>}</strong></div>
        <div><span>Duration</span><strong>{duration === undefined ? "—" : formatDuration(duration)}</strong></div>
        <div><span>Viewport</span><strong>{run.executionSnapshot.viewport.width} × {run.executionSnapshot.viewport.height}</strong></div>
        <div><span>Evidence</span><strong>{report.artifacts.length}<small> artifacts</small></strong></div>
      </section>

      <section className="report-layout">
        <div className="report-main">
          <div className="panel">
            <PanelHeader title="Execution timeline" kicker={`${run.planSnapshot.steps.length} PLANNED STEPS`} />
            <div className="timeline">
              {run.planSnapshot.steps.map((step, index) => {
                const failure = report.events.find((event) => event.type === "step.failed" && event.payload.stepId === step.id);
                const pass = report.events.find((event) => event.type === "step.passed" && event.payload.stepId === step.id);
                return (
                  <div className={`timeline-step ${failure ? "step-failed" : pass ? "step-passed" : "step-waiting"}`} key={step.id}>
                    <div className="step-rail"><span>{failure ? <X size={14} /> : pass ? <Check size={14} /> : index + 1}</span></div>
                    <div className="step-body">
                      <div><strong>{step.title}</strong><code>{step.action.type}</code></div>
                      <span>{failure ? String(failure.payload.error) : pass ? "Completed successfully" : "Not evaluated"}</span>
                      {step.after && <div className="assertion-line"><LoaderCircle size={14} /> Readiness · {step.after.conditions.map((condition) => condition.type).join(step.after.mode === "all" ? " + " : " or ")} · up to {Math.round(step.after.timeoutMs / 1000)}s</div>}
                      {step.captureIntent === "transient" && <div className="assertion-line"><AlertTriangle size={14} /> Transient observation · not completed-state proof</div>}
                      {report.assertions.filter((a) => a.stepId === step.id).map((assertion) => (
                        <div className={`assertion-line assertion-${assertion.status}`} key={assertion.assertionIndex}>
                          {assertion.status === "passed" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          {assertion.assertionType} assertion · {assertion.status}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="panel">
            <PanelHeader title="Captured evidence" kicker="ARTIFACTS" />
            {videos.map((artifact) => <AuthenticatedVideo artifact={artifact} key={artifact.id} />)}
            {screenshots.length ? (
              <div className="evidence-grid">
                {screenshots.map((artifact) => (
                  <AuthenticatedArtifact
                    artifact={artifact}
                    image
                    key={artifact.id}
                  />
                ))}
              </div>
            ) : (
              <EmptyBlock icon={<Image />} title="No screenshots available" copy="Evidence appears as the worker finalizes artifacts." />
            )}
            <div className="artifact-strip">
              {report.artifacts.filter((a) => a.kind !== "screenshot" && a.kind !== "video").map((artifact) => (
                <AuthenticatedArtifact artifact={artifact} key={artifact.id} />
              ))}
            </div>
          </div>
        </div>
        <aside className="report-side">
          <div className="panel">
            <PanelHeader title="Run context" kicker="IMMUTABLE SNAPSHOT" />
            <dl className="context-list">
              <div><dt>Access scope</dt><dd>Flow destinations only</dd></div>
              <div><dt>Starting origin</dt><dd>{run.environmentSnapshot.baseOrigin}</dd></div>
              <div><dt>Browser</dt><dd>Chrome / {run.executionSnapshot.browser}</dd></div>
              <div><dt>Seed</dt><dd>{run.executionSnapshot.seed}</dd></div>
              <div><dt>Attempt</dt><dd>{currentAttempt?.attemptNumber ?? "—"}</dd></div>
              {run.rerunOfRunId && <div><dt>Rerun of</dt><dd>#{run.rerunOfRunId.slice(0, 8)}</dd></div>}
              {run.resolvedByRunId && <div><dt>Resolved by</dt><dd>#{run.resolvedByRunId.slice(0, 8)}</dd></div>}
            </dl>
          </div>
          <div className="panel">
            <PanelHeader title="Diagnostics" kicker={`${diagnostics.length + policyEvents.length} SIGNALS`} />
            <div className="diagnostics">
              {policyEvents.map((event) => (
                <div key={event.id}>
                  <ShieldCheck size={15} />
                  <div>
                    <strong>{event.payload.disposition === "blocked_subresource" ? "OPTIONAL RESOURCE BLOCKED" : "POLICY REJECTION"}{event.payload.resourceType ? ` · ${String(event.payload.resourceType)}` : ""}</strong>
                    <span>{String(event.payload.message ?? "")}</span>
                    {Boolean(event.payload.target) && <code>{String(event.payload.target)}</code>}
                  </div>
                </div>
              ))}
              {diagnostics.map((event) => (
                <div key={event.id}>
                  <TerminalSquare size={15} />
                  <div><strong>{event.type.replace("diagnostic.", "")}</strong><span>{String(event.payload.message ?? "")}</span>{Boolean(event.payload.url) && <code>{String(event.payload.url)}</code>}</div>
                </div>
              ))}
              {!diagnostics.length && !policyEvents.length && <div className="clean-signal"><ShieldCheck size={20} /><strong>Clean session</strong><span>No console, page, policy, or failed-request signals.</span></div>}
            </div>
          </div>
        </aside>
      </section>
    </>
  );
}

function Settings({ projectId }: { projectId: string }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<Credential[]>(`/projects/${projectId}/credentials`)
      .then(setCredentials)
      .catch((cause) => setError(message(cause)));
  }, [projectId]);

  useEffect(load, [load]);

  const deleteCredential = async (credential: Credential) => {
    if (!window.confirm(`Remove “${credential.name}”? Flows using it will need another credential before they can run.`)) return;
    setError("");
    try {
      await remove(`/credentials/${credential.id}`);
      load();
    } catch (cause) {
      setError(message(cause));
    }
  };

  return (
    <>
      <PageTitle eyebrow="PROJECT SCOPE" title="Project settings" copy="Defaults applied to new Flow runs in this project." />
      <section className="panel policy-defaults">
        <div><span className="eyebrow">EXECUTION DEFAULTS</span><h3>Configured inside each Flow</h3><p>Every Flow owns its related URLs and ordered Sequence. Scry generates its safety boundaries automatically and preserves them with every report.</p></div>
        <div className="policy-facts"><span><Check size={14} /> Chromium</span><span><Check size={14} /> 1280 × 720</span><span><Check size={14} /> Flow-scoped access</span></div>
      </section>
      <section className="panel credential-settings">
        <div className="credential-settings-head">
          <div><span className="eyebrow">PROTECTED TEST INFORMATION</span><h3>Test credentials</h3><p>Passwords, private test accounts, and API values used by this project’s Flows.</p></div>
          <button className="primary-button" onClick={() => setDialog(true)}><Plus size={15} /> Add credential</button>
        </div>
        {error && <div className="form-error"><AlertTriangle size={15} /> {error}</div>}
        <div className="credential-list">
          {credentials.map((credential) => (
            <div key={credential.id}>
              <span className="credential-icon"><KeyRound size={17} /></span>
              <div><strong>{credential.name}</strong><small>Value protected · updated {relativeTime(credential.updatedAt)}</small></div>
              <span className="credential-value">••••••••••••</span>
              <button className="icon-button" aria-label={`Remove ${credential.name}`} onClick={() => void deleteCredential(credential)}><Trash2 size={15} /></button>
            </div>
          ))}
          {!credentials.length && <EmptyBlock icon={<KeyRound />} title="No test credentials yet" copy="Add protected information once, then select it safely inside any Flow." />}
        </div>
      </section>
      {dialog && <CredentialDialog projectId={projectId} onClose={() => setDialog(false)} onSaved={() => { setDialog(false); load(); }} />}
    </>
  );
}

function Integrations() {
  const [tokens, setTokens] = useState<McpAccessToken[]>([]);
  const [revealedToken, setRevealedToken] = useState("");
  const [client, setClient] = useState<"codex" | "claude" | "generic">("codex");
  const [setupMethod, setSetupMethod] = useState<"app" | "cli">("app");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = new URL(publicConfig.mcpServerUrl, window.location.origin).toString();

  const load = useCallback(() => {
    void api<McpAccessToken[]>("/mcp-tokens").then(setTokens).catch((cause) => setError(message(cause)));
  }, []);

  useEffect(load, [load]);

  const createToken = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await post<McpAccessToken>("/mcp-tokens", { name: `${setupLabel(client, setupMethod)} connection` });
      setRevealedToken(created.token ?? "");
      setTokens((current) => [created, ...current]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (token: McpAccessToken) => {
    if (!window.confirm(`Revoke “${token.name}”? Connected clients using it will stop working.`)) return;
    try {
      const revoked = await remove<McpAccessToken>(`/mcp-tokens/${token.id}`);
      setTokens((current) => current.map((item) => item.id === revoked.id ? revoked : item));
    } catch (cause) {
      setError(message(cause));
    }
  };

  const tokenValue = revealedToken || "<YOUR_SCRY_MCP_TOKEN>";
  const claudeHosted = client === "claude" && setupMethod === "app";
  const instructions = client === "codex" && setupMethod === "app"
    ? `Open Settings → Plugins → MCPs → Add server\n\nName: Scry\nType: Streamable HTTP\nURL: ${endpoint}\nHeader key: Authorization\nHeader value: Bearer ${tokenValue}\n\nSave, then restart the app.`
    : client === "codex"
      ? `export SCRY_MCP_TOKEN="${tokenValue}"\n\ncodex mcp add scry --url ${endpoint} \\\n  --bearer-token-env-var SCRY_MCP_TOKEN`
      : client === "claude" && setupMethod === "cli"
        ? `claude mcp add --transport http scry ${endpoint} \\\n  --header "Authorization: Bearer ${tokenValue}"\n\n# In Claude Code, run /mcp to verify the connection.`
        : claudeHosted
          ? `Current Scry MCP URL:\n${endpoint}\n\nClaude / Claude Desktop support is coming with Scry's managed OAuth connection.\n\nWhen available:\n\n• Open Settings → Connectors\n• Select Add custom connector\n• Enter the Scry MCP URL shown here\n• Sign in to Scry and enable its tools\n\nScry access tokens are not accepted by this connection method. Use Claude Code CLI with an access token today.`
          : `Transport: Streamable HTTP\nEndpoint: ${endpoint}\nHeader: Authorization: Bearer ${tokenValue}`;

  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE INTEGRATION"
        title="Connect Scry to your AI client"
        copy="Use Scry from Codex, Claude, or any MCP-compatible client. The same tools and workspace permissions apply everywhere."
      />
      <section className="integration-hero panel">
        <div className="integration-mark"><PlugZap size={25} /></div>
        <div>
          <span className="eyebrow lime">MODEL CONTEXT PROTOCOL</span>
          <h2>One open protocol, not a Codex-only integration</h2>
          <p>Scry exposes standard MCP tools over Streamable HTTP for remote clients and stdio for local development. Your access token is scoped to this workspace and can be revoked at any time.</p>
        </div>
        <span className="integration-ready"><i /> Remote endpoint ready</span>
      </section>

      <section className="integration-layout">
        <div className="panel integration-setup">
          <div className="integration-section-head">
            <div><span className="eyebrow">SETUP GUIDE</span><h2>Choose your client</h2></div>
            <span className="transport-pill">Streamable HTTP</span>
          </div>
          <div className="client-tabs">
            {(["codex", "claude", "generic"] as const).map((item) => (
              <button key={item} className={client === item ? "selected" : ""} onClick={() => {
                setClient(item);
                if (item === "generic") setSetupMethod("cli");
                else setSetupMethod(item === "codex" ? "app" : "cli");
              }}>{clientLabel(item)}</button>
            ))}
          </div>
          {client !== "generic" && (
            <div className="setup-method-tabs" aria-label={`${clientLabel(client)} setup method`}>
              {(client === "codex"
                ? [["app", "ChatGPT / Codex app"], ["cli", "CLI"]]
                : [["cli", "Claude Code CLI"], ["app", "Claude / Desktop"]]
              ).map(([method, label]) => (
                <button key={method} className={setupMethod === method ? "selected" : ""} onClick={() => setSetupMethod(method as "app" | "cli")}>{label}</button>
              ))}
            </div>
          )}
          <div className={`mcp-endpoint-card ${claudeHosted ? "endpoint-incompatible" : ""}`}>
            <div className="mcp-endpoint-copy">
              <span className="eyebrow">YOUR SCRY MCP URL</span>
              <code>{endpoint}</code>
            </div>
            <button onClick={() => void navigator.clipboard.writeText(endpoint)}><Copy size={14} /> Copy URL</button>
            <div className="mcp-endpoint-status">
              {claudeHosted ? (
                <><AlertTriangle size={15} /><span><strong>Claude / Desktop connection coming soon</strong>This connection method will be enabled when Scry’s managed OAuth support is ready.</span></>
              ) : (
                <><CheckCircle2 size={15} /><span><strong>Ready for this setup</strong>This client can connect to the local Streamable HTTP endpoint.</span></>
              )}
            </div>
          </div>
          <ol className="integration-steps">
            {claudeHosted ? (
              <>
                <li><span>1</span><div><strong>Managed by Scry</strong><p>Scry will provide the compatible OAuth connection automatically. There will be no hosting or server setup for the user.</p></div></li>
                <li><span>2</span><div><strong>Add the custom connector</strong><p>When available, open Settings → Connectors → Add custom connector and enter the Scry MCP URL shown above.</p></div></li>
                <li><span>3</span><div><strong>Sign in and enable tools</strong><p>Sign in to Scry when Claude asks, then enable Scry from Search and tools.</p></div></li>
              </>
            ) : (
              <>
                <li><span>1</span><div><strong>Create an access token</strong><p>Scry shows the complete token once. Store it in your client’s secret or environment configuration.</p></div></li>
                <li><span>2</span><div><strong>Add the Scry MCP server</strong><p>{clientHelp(client, setupMethod)}</p></div></li>
                <li><span>3</span><div><strong>Verify the connection</strong><p>Ask your client to list Scry projects. It should call <code>list_projects</code> and return only this workspace.</p></div></li>
              </>
            )}
          </ol>
          <div className="integration-command">
            <div><span>{setupLabel(client, setupMethod)} setup</span><button onClick={() => void navigator.clipboard.writeText(instructions)}><Copy size={14} /> Copy</button></div>
            <pre>{instructions}</pre>
          </div>
          {claudeHosted && (
            <div className="integration-auth-answer">
              <KeyRound size={17} />
              <div><strong>Can I use a Scry access token here?</strong><span>No—not in the Claude/Claude Desktop connector. Use the <button onClick={() => setSetupMethod("cli")}>Claude Code CLI</button> option with an access token today. The Claude/Desktop option will use Scry sign-in when it becomes available.</span></div>
            </div>
          )}
          {revealedToken && !claudeHosted && (
            <div className="token-reveal">
              <AlertTriangle size={17} />
              <div><strong>Copy this token now</strong><span>For security, Scry cannot show the full value again after you leave this page.</span></div>
            </div>
          )}
          {error && <div className="form-error"><AlertTriangle size={15} /> {error}</div>}
          {!claudeHosted && <button className="primary-button integration-create" disabled={busy} onClick={() => void createToken()}>
            <KeyRound size={15} /> {busy ? "Creating…" : "Create access token"}
          </button>}
        </div>

        <aside className="panel integration-tokens">
          <div className="integration-section-head"><div><span className="eyebrow">SECURITY</span><h2>Access tokens</h2></div></div>
          <p className="integration-aside-copy">Each client should have its own token so you can disconnect it without affecting the others.</p>
          <div className="integration-token-list">
            {tokens.map((token) => (
              <div key={token.id} className={token.revokedAt ? "revoked" : ""}>
                <div><strong>{token.name}</strong><code>{token.tokenPrefix}</code><small>{token.revokedAt ? "Revoked" : token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}</small></div>
                {!token.revokedAt && <button aria-label={`Revoke ${token.name}`} onClick={() => void revokeToken(token)}><Trash2 size={14} /></button>}
              </div>
            ))}
            {!tokens.length && <EmptyBlock icon={<KeyRound />} title="No access tokens" copy="Create one when you are ready to connect a client." />}
          </div>
        </aside>
      </section>
      <section className="integration-note panel">
        <ShieldCheck size={19} />
        <div><strong>What “compatible” means</strong><span>Any client that supports MCP Streamable HTTP and bearer headers can connect using a Scry access token. Clients that require OAuth will become available through Scry’s managed sign-in connection. Legacy SSE-only clients are not supported.</span></div>
      </section>
    </>
  );
}

function clientLabel(client: "codex" | "claude" | "generic") {
  return client === "codex" ? "Codex" : client === "claude" ? "Claude" : "Other MCP client";
}

function setupLabel(client: "codex" | "claude" | "generic", method: "app" | "cli") {
  if (client === "codex") return method === "app" ? "Codex app" : "Codex CLI";
  if (client === "claude") return method === "app" ? "Claude / Desktop" : "Claude Code CLI";
  return "Other MCP client";
}

function clientHelp(client: "codex" | "claude" | "generic", method: "app" | "cli") {
  if (client === "codex" && method === "app") return "Use the Plugins → MCPs screen in the ChatGPT desktop app. Add the URL and authorization header shown below, save, then restart the app.";
  if (client === "codex") return "Run the command below, then use codex mcp list or /mcp to verify the server.";
  if (client === "claude") return "Run the command below in a terminal. Use /mcp in Claude Code to inspect the connection.";
  return "Add a remote MCP server using the endpoint and bearer header below. The transport must be Streamable HTTP.";
}

function WorkspaceSettings({ userEmail, projects }: { userEmail: string; projects: Project[] }) {
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE SCOPE"
        title="Workspace settings"
        copy="Shared ownership, projects, and access across your Scry workspace."
      />
      <section className="settings-grid">
        <div className="panel settings-card">
          <div className="account-settings-icon"><Box size={20} /></div>
          <div><span className="eyebrow">WORKSPACE</span><h3>Scry workspace</h3><p>The shared boundary containing your projects and durable test history.</p></div>
          <dl><div><dt>Projects</dt><dd>{projects.length}</dd></div><div><dt>Plan</dt><dd>Local development</dd></div></dl>
        </div>
        <div className="panel settings-card">
          <div className="account-settings-icon"><ShieldCheck size={20} /></div>
          <div><span className="eyebrow">MEMBERS & ACCESS</span><h3>Workspace owner</h3><p>Team roles and invitations will be managed at this scope.</p></div>
          <dl><div><dt>Owner</dt><dd>{userEmail}</dd></div><div><dt>Role</dt><dd>Administrator</dd></div></dl>
        </div>
      </section>
      <section className="panel settings-note"><AlertTriangle size={18} /><div><strong>Team management is not enabled yet</strong><span>The current local workspace has one owner. Invitations and role controls will appear here when multi-user access is enabled.</span></div></section>
    </>
  );
}

function AccountSettings({ userEmail }: { userEmail: string }) {
  return (
    <>
      <PageTitle
        eyebrow="PERSONAL ACCOUNT"
        title="Account settings"
        copy="Your identity and sign-in details across every Scry workspace."
      />
      <section className="account-settings-grid">
        <div className="panel account-settings-card">
          <div className="account-settings-icon"><Settings2 size={20} /></div>
          <div>
            <span className="eyebrow">PROFILE</span>
            <h3>Account identity</h3>
            <p>The email address associated with your Scry account.</p>
          </div>
          <div className="account-setting-row">
            <span>Email address</span>
            <strong>{userEmail}</strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon"><ShieldCheck size={20} /></div>
          <div>
            <span className="eyebrow">AUTHENTICATION</span>
            <h3>Secure sign-in</h3>
            <p>Password, email verification, and connected sign-in providers are managed securely through Supabase.</p>
          </div>
          <div className="account-setting-row">
            <span>Status</span>
            <strong className="account-status"><i /> Active</strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon"><Gauge size={20} /></div>
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h3>Personal defaults</h3>
            <p>Display, time zone, and notification preferences belong only to your account.</p>
          </div>
          <div className="account-setting-row">
            <span>Time zone</span>
            <strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

function SpecDialog({
  projectId,
  specification,
  environment,
  credentials,
  onCredentialCreated,
  onClose,
  onCreated,
}: {
  projectId: string;
  specification?: Specification | undefined;
  environment?: Environment | undefined;
  credentials: Credential[];
  onCredentialCreated: (credential: Credential) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const initialDestinations = destinationsFromFlow(specification, environment);
  const initialSequence = sequenceFromFlow(specification);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(specification?.name ?? "");
  const [objective, setObjective] = useState(specification?.latestContent?.objective ?? specification?.description ?? "");
  const [destinations, setDestinations] = useState(initialDestinations);
  const [sequence, setSequence] = useState<SequenceDraft[]>(initialSequence);
  const [customPlanText, setCustomPlanText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [credentialDialog, setCredentialDialog] = useState(false);
  const outcomes = sequence.flatMap((item) => [
    ...(item.type === "waitFor" && item.target.trim()
      ? [`After “${item.title}”: “${item.target}” is visible`]
      : []),
    ...item.verifications
      .filter((verification) => verification.value.trim())
      .map((verification) =>
        verification.type === "url"
          ? `After “${item.title}”: the page address contains “${verification.value.trim()}”`
          : `After “${item.title}”: “${verification.value.trim()}” is ${verification.type}`,
      ),
  ]);
  const validDestinations = destinations
    .map((item) => ({ ...item, url: normalizedUrl(item.url), origin: canonicalOrigin(item.url) }))
    .filter((item): item is typeof item & { url: string; origin: string } => Boolean(item.url && item.origin));
  const allowedOrigins = [...new Set(validDestinations.map((item) => item.origin))];
  const targetFor = (action: SequenceDraft) => action.targetStrategy === "role"
    ? { strategy: "role", role: action.targetRole, name: action.target, exact: true }
    : action.targetStrategy === "text"
      ? { strategy: "text", value: action.target, exact: true }
      : { strategy: action.targetStrategy, value: action.target };
  const readinessFor = (action: SequenceDraft) => {
    if (!["navigate", "click"].includes(action.type)) return undefined;
    const timeoutMs = action.readinessTimeoutMs;
    if (action.readinessType === "visible" || action.readinessType === "hidden") {
      return { mode: "all", timeoutMs, conditions: [{ type: action.readinessType, target: { strategy: "text", value: action.readinessValue, exact: true } }] };
    }
    if (action.readinessType === "url") {
      return { mode: "all", timeoutMs, conditions: [{ type: "url", expected: action.readinessValue, match: "contains" }] };
    }
    if (action.readinessType === "content") {
      return { mode: "all", timeoutMs, conditions: [{ type: "content", target: { strategy: "css", value: action.readinessValue, justification: "User-selected application content container" }, minimumChildren: 1 }] };
    }
    if (action.readinessType === "request") {
      return { mode: "all", timeoutMs, conditions: [{ type: "request", urlPattern: action.readinessValue, status: { min: 200, max: 399 } }] };
    }
    if (action.readinessType === "delay") {
      return { mode: "all", timeoutMs, conditions: [{ type: "delay", durationMs: Math.min(timeoutMs, Math.max(100, Number(action.readinessValue) || 1000)) }] };
    }
    return { mode: "all", timeoutMs, conditions: [{ type: "domStable", quietWindowMs: 500 }, { type: "networkQuiet", quietWindowMs: 500, ignoreUrlPatterns: [] }] };
  };
  const sequenceSteps = sequence.map((item, index) => {
    const base = {
      id: `step-${index + 1}-${item.type}`,
      title: item.title.trim() || `${item.type} step`,
      assertions: item.verifications
        .filter((verification) => verification.value.trim())
        .map((verification) => verification.type === "url"
          ? { type: "url", expected: verification.value.trim(), match: "contains" }
          : {
              type: verification.type,
              target: { strategy: "text", value: verification.value.trim(), exact: true },
            }) as Array<Record<string, unknown>>,
      evidence: item.type === "waitFor" ? ["screenshot", "dom"] : ["network"],
      ...(readinessFor(item) ? { after: readinessFor(item) } : {}),
      captureIntent: "final",
    };
    if (item.type === "navigate") {
      const url = normalizedUrl(item.url) ?? item.url;
      return {
        ...base,
        action: { type: "navigate", url },
        evidence: ["screenshot", "network"],
      };
    }
    if (item.type === "fill") {
      return {
        ...base,
        action: {
          type: "fill",
          target: targetFor(item),
          ...(item.valueMode === "secret" ? { secretRef: item.value.trim() } : { value: item.value }),
        },
      };
    }
    if (item.type === "click") {
      return { ...base, action: { type: "click", target: targetFor(item) } };
    }
    if (item.type === "waitFor") {
      return {
        ...base,
        action: { type: "waitFor", target: targetFor(item), state: "visible" },
        assertions: [{ type: "visible", target: targetFor(item) }, ...base.assertions],
      };
    }
    return {
      ...base,
      action: { type: "screenshot", name: `sequence-${index + 1}`, fullPage: true },
      evidence: ["dom"],
    };
  });
  const generatedSteps = sequenceSteps.length
    ? sequenceSteps
    : validDestinations.map((destination, index) => ({
        id: `visit-${index + 1}`,
        title: destination.purpose.trim() || `Visit destination ${index + 1}`,
        action: { type: "navigate", url: destination.url },
        evidence: ["screenshot", "network"],
      }));
  const generatedPlan = {
    protocolVersion: "2",
    name: name.trim() || "Untitled journey",
    objective: objective.trim() || "Verify the selected user journey.",
    allowedOrigins: allowedOrigins.length ? allowedOrigins : ["https://example.com"],
    budgets: {
      maxActions: Math.max(10, generatedSteps.length + 1),
      maxDurationMs: 60000,
      maxNavigations: Math.max(3, validDestinations.length),
    },
    steps: [
      ...generatedSteps,
      ...(!generatedSteps.some((item) => item.action.type === "screenshot")
        ? [{
            id: "capture-final-state",
            title: "Capture the completed journey",
            action: { type: "screenshot", name: "completed-journey", fullPage: true },
            assertions: [],
            evidence: ["dom"],
            captureIntent: "final",
          }]
        : []),
    ],
  };
  const planText = customPlanText || JSON.stringify(generatedPlan, null, 2);

  const continueWizard = () => {
    setError("");
    if (step === 0 && (!name.trim() || !objective.trim())) {
      setError("Add a clear name and objective before continuing.");
      return;
    }
    if (step === 1 && (validDestinations.length !== destinations.length || !destinations.length)) {
      setError("Every destination needs a valid HTTP or HTTPS URL.");
      return;
    }
    if (step === 1 && allowedOrigins.length > 5) {
      setError("A Flow can use at most five related origins.");
      return;
    }
    if (step === 1 && destinations.some((item) => !item.purpose.trim())) {
      setError("Explain why each destination belongs in this Flow.");
      return;
    }
    if (step === 2 && !sequence.length) {
      setError("Add at least one action to the Sequence.");
      return;
    }
    if (step === 2 && sequence.some((item) =>
      !item.title.trim()
      || (item.type === "navigate" && !normalizedUrl(item.url))
      || (["fill", "click", "waitFor"].includes(item.type) && !item.target.trim())
      || (item.type === "fill" && !item.value.trim())
      || (["navigate", "click"].includes(item.type) && item.readinessType !== "settle" && !item.readinessValue.trim())
    )) {
      setError("Complete every action’s title, target, value, and post-action readiness condition.");
      return;
    }
    if (step === 2 && outcomes.length === 0) {
      setError("Add at least one proof check so Scry knows whether the Flow succeeded.");
      return;
    }
    if (step === 1 && !sequence.length) {
      setSequence(validDestinations.map((destination) => newSequenceAction("navigate", {
        title: destination.purpose,
        url: destination.url,
      })));
    }
    setStep((current) => Math.min(current + 1, 3));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step < 3) {
      continueWizard();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const plan = JSON.parse(planText);
      const environmentInput = {
        baseOrigin: allowedOrigins[0],
        policy: {
          policyVersion: "1",
          allowedOrigins,
          allowPrivateNetwork: allowedOrigins.some((origin) => origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")),
          allowDownloads: false,
          allowPopups: false,
          maxActions: 100,
          maxDurationMs: 120000,
          maxNavigations: 10,
        },
        secretRefs: sequence.filter((item) => item.type === "fill" && item.valueMode === "secret").map((item) => item.value),
      };
      const spec = specification
        ? await patch<{ id: string }>(`/specifications/${specification.id}`, { name, description: objective })
        : await post<{ id: string }>(`/projects/${projectId}/specifications`, { name, description: objective });
      if (specification && environment) {
        await patch<Environment>(`/environments/${environment.id}`, environmentInput);
      } else if (specification) {
        await post<Environment>(`/projects/${projectId}/environments`, {
          ...environmentInput,
          name: `flow:${spec.id}`,
        });
      } else {
        await post<Environment>(`/projects/${projectId}/environments`, {
          ...environmentInput,
          name: `flow:${spec.id}`,
        });
      }
      const version = await post<{ id: string }>(`/specifications/${spec.id}/versions`, {
        objective,
        expectedOutcomes: outcomes,
      });
      await post("/plans/versions", { specificationVersionId: version.id, plan });
      onCreated();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={specification ? "Edit Flow" : "Create Flow"} subtitle={`Step ${step + 1} of 4 · ${["Describe the journey", "Add related pages", "Add instructions and proof", "Review and save"][step]}`} onClose={onClose} wide>
      <form onSubmit={(event) => void submit(event)} className="spec-wizard">
        <div className="wizard-progress wizard-progress-four" aria-label={`Step ${step + 1} of 4`}>
          {["Goal", "Pages", "Instructions + proof", "Review"].map((label, index) => (
            <div className={index < step ? "complete" : index === step ? "current" : ""} key={label}>
              <span>{index < step ? <Check size={13} /> : index + 1}</span><small>{label}</small>
            </div>
          ))}
        </div>
        <div className={`wizard-body wizard-step-${step}`}>
          {step === 0 && (
            <div className="wizard-fields">
              <div className="wizard-copy"><span className="eyebrow lime">THE USER JOURNEY</span><h3>What should Scry verify?</h3><p>Use a short, recognizable name and describe the behavior that matters.</p></div>
              <label><span>Flow name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Signup and onboarding" /></label>
              <label><span>Objective</span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Verify that a new user can create an account and reach onboarding." /></label>
            </div>
          )}
          {step === 1 && (
            <div className="wizard-fields">
              <div className="wizard-copy"><span className="eyebrow lime">PAGES SCRY MAY VISIT</span><h3>Where should this test happen?</h3><p>Start with the page where Scry should begin. Add another page only when this same journey must continue somewhere else.</p></div>
              <div className="wizard-guide">
                <div><strong>1</strong><span><b>Add the starting page</b><small>The exact page Scry should open first—not just your company homepage.</small></span></div>
                <div><strong>2</strong><span><b>Explain what happens there</b><small>For example: “Open the sign-in page” or “Complete payment.”</small></span></div>
                <div><strong>3</strong><span><b>Add related pages only if needed</b><small>A verification portal or checkout provider can belong here when it is part of this same journey.</small></span></div>
              </div>
              <div className="destination-list">
                {destinations.map((destination, index) => (
                  <div className="destination-row" key={destination.id}>
                    <span className="sequence-number">{index + 1}</span>
                    <div className="destination-fields">
                      <label><span>{index === 0 ? "Page where Scry starts" : "Next related page"}</span><input autoFocus={index === 0} type="url" value={destination.url} onChange={(event) => setDestinations((items) => items.map((item) => item.id === destination.id ? { ...item, url: event.target.value } : item))} placeholder={index === 0 ? "https://app.example.com/login" : "https://checkout.example.com/payment"} /><small>{index === 0 ? "Paste the full address of the first page Scry should open." : "Add this only if the same test journey continues on another website or subdomain."}</small></label>
                      <label><span>What should happen on this page?</span><input value={destination.purpose} onChange={(event) => setDestinations((items) => items.map((item) => item.id === destination.id ? { ...item, purpose: event.target.value } : item))} placeholder={index === 0 ? "Sign in with the test account" : "Complete the payment step"} /><small>Use a short instruction. This becomes the suggested first step for this page.</small></label>
                    </div>
                    {destinations.length > 1 && <button type="button" className="icon-button destination-remove" aria-label="Remove destination" onClick={() => setDestinations((items) => items.filter((item) => item.id !== destination.id))}><X size={16} /></button>}
                  </div>
                ))}
              </div>
              {destinations.length < 5 && <button type="button" className="secondary-button add-destination" onClick={() => setDestinations((items) => [...items, { id: crypto.randomUUID(), url: "", purpose: "" }])}><Plus size={15} /> Add related URL</button>}
              <div className="wizard-hint"><ShieldCheck size={17} /><span>Scry can visit only the pages you approve here. This prevents the test from wandering into unrelated websites.</span></div>
            </div>
          )}
          {step === 2 && (
            <div className="wizard-fields">
              <div className="wizard-copy"><span className="eyebrow lime">STEP-BY-STEP INSTRUCTIONS</span><h3>Tell Scry how to complete the journey</h3><p>Write the steps as if you were giving instructions to a new teammate. Scry will perform them from top to bottom.</p></div>
              <div className="wizard-example">
                <span>GOOD EXAMPLE</span>
                <div><b>1</b><p><strong>Open the sign-in page</strong><small>Navigate · https://app.example.com/login</small></p></div>
                <div><b>2</b><p><strong>Enter the account email</strong><small>Fill field · “Email address”</small></p></div>
                <div><b>3</b><p><strong>Submit the form</strong><small>Click · “Sign in” button</small></p></div>
                <div><b>4</b><p><strong>Confirm the dashboard appears</strong><small>Wait and verify · “Dashboard” heading</small></p></div>
              </div>
              <div className="sequence-builder">
                {sequence.map((action, index) => (
                  <div className="sequence-card sequence-action-card" key={action.id}>
                    <span className="sequence-number">{index + 1}</span>
                    <div className="sequence-action-fields">
                      <div className="sequence-action-head">
                        <label><span>What should Scry do?</span><WizardSelect value={action.type} options={[["navigate", "Open a page", "Go to one of the pages added earlier."], ["fill", "Enter information", "Type a test value into a form field."], ["click", "Click something", "Click a button, link, checkbox, or other control."], ["waitFor", "Check that something appears", "Wait for visible proof that the step worked."], ["screenshot", "Take a screenshot", "Capture the page at this point in the journey."]]} onChange={(value) => setSequence((items) => items.map((item) => item.id === action.id ? { ...newSequenceAction(value as SequenceActionType), id: item.id, title: item.title, verifications: item.verifications } : item))} /></label>
                        <div className="sequence-order-controls">
                          <button type="button" disabled={index === 0} onClick={() => setSequence((items) => moveItem(items, index, index - 1))}>↑</button>
                          <button type="button" disabled={index === sequence.length - 1} onClick={() => setSequence((items) => moveItem(items, index, index + 1))}>↓</button>
                          <button type="button" aria-label="Remove action" onClick={() => setSequence((items) => items.filter((item) => item.id !== action.id))}><X size={14} /></button>
                        </div>
                      </div>
                      <label><span>Describe this step</span><input value={action.title} onChange={(event) => updateSequence(setSequence, action.id, { title: event.target.value })} placeholder="Enter the account email" /><small>Write what a person would understand when reading the final report.</small></label>
                      {action.type === "navigate" && <label><span>Which page should Scry open?</span><WizardSelect value={action.url} options={[["", "Choose a page", "Select one of the pages approved in the previous step."], ...validDestinations.map((destination) => [destination.url, destination.url, destination.purpose] as [string, string, string])]} onChange={(value) => updateSequence(setSequence, action.id, { url: value })} /></label>}
                      {["fill", "click", "waitFor"].includes(action.type) && (
                        <>
                          <label><span>{action.type === "fill" ? "Which field should Scry fill?" : action.type === "click" ? "What should Scry click?" : "What should appear on the page?"}</span><input value={action.target} onChange={(event) => updateSequence(setSequence, action.id, { target: event.target.value })} placeholder={action.type === "fill" ? "Email address" : action.type === "click" ? "Sign in" : "Dashboard"} /><small>Enter the words a user can see on or beside the element.</small></label>
                          <details className="sequence-advanced">
                            <summary>Change how Scry finds this element</summary>
                            <p>Most users can keep these defaults. Change them only when Scry cannot find the element.</p>
                            <div className="sequence-target-grid">
                              <label><span>Find it using</span><WizardSelect value={action.targetStrategy} options={[["role", "Element type and name"], ["label", "Field label"], ["placeholder", "Placeholder text"], ["text", "Visible text"], ["testId", "Test ID"]]} onChange={(value) => updateSequence(setSequence, action.id, { targetStrategy: value as SequenceDraft["targetStrategy"] })} /></label>
                              {action.targetStrategy === "role" && <label><span>Element type</span><WizardSelect value={action.targetRole} options={[["button", "Button"], ["link", "Link"], ["heading", "Heading"], ["textbox", "Text field"]]} onChange={(value) => updateSequence(setSequence, action.id, { targetRole: value as SequenceDraft["targetRole"] })} /></label>}
                            </div>
                          </details>
                        </>
                      )}
                      {action.type === "fill" && (
                        <div className="sequence-value-grid">
                          <label><span>Where does the information come from?</span><WizardSelect value={action.valueMode} options={[["value", "Use this test value", "Safe information that can be stored in the Flow."], ["secret", "Use protected information", "Passwords and private values resolved only during the run."]]} onChange={(value) => updateSequence(setSequence, action.id, { valueMode: value as SequenceDraft["valueMode"], value: "" })} /></label>
                          {action.valueMode === "secret" ? (
                            <label>
                              <span>Which saved credential should Scry use?</span>
                              <WizardSelect
                                value={action.value}
                                options={[
                                  ["", "Choose a credential", "The secret value will never be added to this Flow."],
                                  ...credentials.map((credential) => [credential.id, credential.name, "Protected project credential"] as [string, string, string]),
                                  ...(action.value && !credentials.some((credential) => credential.id === action.value)
                                    ? [[action.value, "Unavailable legacy credential", "Choose or create a current project credential."] as [string, string, string]]
                                    : []),
                                ]}
                                onChange={(value) => updateSequence(setSequence, action.id, { value })}
                              />
                              <button type="button" className="inline-create-credential" onClick={() => setCredentialDialog(true)}><Plus size={14} /> Add a new credential</button>
                              <small>Scry stores only the credential ID in this Flow and decrypts the value during the run.</small>
                            </label>
                          ) : (
                            <label><span>Information to enter</span><input type="text" value={action.value} onChange={(event) => updateSequence(setSequence, action.id, { value: event.target.value })} placeholder="test@example.com" /><small>This value is stored with the Flow and may appear in evidence.</small></label>
                          )}
                        </div>
                      )}
                      {["navigate", "click"].includes(action.type) && (
                        <div className="step-readiness">
                          <div className="step-proof-head">
                            <div><LoaderCircle size={17} /><span><strong>What should happen before Scry continues?</strong><small>This prevents screenshots and checks from capturing an unfinished loading state.</small></span></div>
                          </div>
                          <div className="sequence-value-grid">
                            <label>
                              <span>Ready when</span>
                              <WizardSelect
                                value={action.readinessType}
                                options={[
                                  ["visible", "Something appears", "Best for a destination heading, form, or result."],
                                  ["hidden", "A loading message disappears", "Wait for a spinner, loading label, or overlay to go away."],
                                  ["url", "The page address changes", "Wait for part of the destination URL."],
                                  ["content", "A section is populated", "Wait for a known content container to receive children."],
                                  ["request", "A request completes", "Wait for a matching API request with a successful status."],
                                  ["settle", "Let Scry detect when the page settles", "Weaker fallback using DOM and network quietness."],
                                  ["delay", "A fixed delay passes", "Advanced fallback; does not prove the page is ready."],
                                ]}
                                onChange={(value) => updateSequence(setSequence, action.id, { readinessType: value as SequenceDraft["readinessType"], readinessValue: "" })}
                              />
                            </label>
                            {action.readinessType !== "settle" && (
                              <label>
                                <span>{action.readinessType === "url" ? "Address should contain" : action.readinessType === "content" ? "Container selector" : action.readinessType === "request" ? "Request URL should contain" : action.readinessType === "delay" ? "Delay in milliseconds" : "Words on the page"}</span>
                                <input
                                  value={action.readinessValue}
                                  onChange={(event) => updateSequence(setSequence, action.id, { readinessValue: event.target.value })}
                                  placeholder={action.readinessType === "url" ? "/dashboard" : action.readinessType === "content" ? "#docs-root" : action.readinessType === "request" ? "/api/orders" : action.readinessType === "delay" ? "1000" : "Run POST"}
                                />
                              </label>
                            )}
                          </div>
                          <label><span>Maximum wait</span><input type="number" min={100} max={60000} step={100} value={action.readinessTimeoutMs} onChange={(event) => updateSequence(setSequence, action.id, { readinessTimeoutMs: Number(event.target.value) || 15000 })} /><small>Maximum 60 seconds and always bounded by the Flow run budget.</small></label>
                        </div>
                      )}
                      <div className="step-proof">
                        <div className="step-proof-head">
                          <div><CheckCircle2 size={17} /><span><strong>How should Scry prove this step worked?</strong><small>Add a check immediately after this instruction.</small></span></div>
                          <button type="button" onClick={() => updateSequence(setSequence, action.id, { verifications: [...action.verifications, { id: crypto.randomUUID(), type: "visible", value: "" }] })}><Plus size={14} /> Add proof</button>
                        </div>
                        {action.verifications.map((verification) => (
                          <div className="verification-row" key={verification.id}>
                            <WizardSelect
                              value={verification.type}
                              options={[
                                ["visible", "Something becomes visible", "Use a message, heading, row, or other visible text."],
                                ["hidden", "Something disappears", "Use a loading message, modal, or removed item."],
                                ["url", "The page address changes", "Check part of the new URL, such as /dashboard."],
                              ]}
                              onChange={(value) => updateVerification(setSequence, action.id, verification.id, { type: value as VerificationDraft["type"] })}
                            />
                            <label><span>{verification.type === "url" ? "Address should contain" : "Words visible on the page"}</span><input value={verification.value} onChange={(event) => updateVerification(setSequence, action.id, verification.id, { value: event.target.value })} placeholder={verification.type === "url" ? "/dashboard" : "Order created successfully"} /></label>
                            <button type="button" className="verification-remove" aria-label="Remove proof" onClick={() => updateSequence(setSequence, action.id, { verifications: action.verifications.filter((item) => item.id !== verification.id) })}><X size={15} /></button>
                          </div>
                        ))}
                        {!action.verifications.length && action.type !== "waitFor" && <p>No proof added yet. Scry will perform this instruction, but it will not use this step to decide whether the Flow passed.</p>}
                        {action.type === "waitFor" && <p className="proof-included"><Check size={14} /> This instruction is already a proof check: “{action.target || "the selected content"}” must become visible.</p>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="sequence-add-actions">
                <span>Add another instruction:</span>
                <button type="button" className="secondary-button" onClick={() => setSequence((items) => [...items, newSequenceAction("fill")])}>Enter information</button>
                <button type="button" className="secondary-button" onClick={() => setSequence((items) => [...items, newSequenceAction("click")])}>Click something</button>
                <button type="button" className="secondary-button" onClick={() => setSequence((items) => [...items, newSequenceAction("waitFor")])}>Check a result</button>
                <button type="button" className="secondary-button" onClick={() => setSequence((items) => [...items, newSequenceAction("screenshot")])}>Take a screenshot</button>
              </div>
              <div className="wizard-hint"><ShieldCheck size={17} /><span>Scry follows these instructions exactly in order. Use “Check that something appears” wherever you need proof that the journey worked.</span></div>
            </div>
          )}
          {step === 3 && (
            <div className="wizard-review">
              <div className="review-summary">
                <div><span>Name</span><strong>{name}</strong></div>
                <div><span>Destinations</span><strong>{destinations.length} related URL{destinations.length === 1 ? "" : "s"}</strong><small>{allowedOrigins.length} permitted origin{allowedOrigins.length === 1 ? "" : "s"}</small></div>
                <div><span>Proof checks</span><strong>{outcomes.length}</strong><small>These checks determine whether the Flow passes.</small></div>
                <div><span>Plan</span><strong>{generatedPlan.steps.length} controlled actions</strong><small>{outcomes.length} executable checks · Chromium</small></div>
              </div>
              <div className="review-sequence">
                {sequence.map((item, index) => <div key={item.id}><span>{index + 1}</span><div><strong>{item.title}</strong><small>{item.type}{item.type === "navigate" ? ` · ${item.url}` : item.target ? ` · ${item.target}` : ""}</small>{(item.verifications.length > 0 || item.type === "waitFor") && <em><CheckCircle2 size={12} /> {item.verifications.length + (item.type === "waitFor" ? 1 : 0)} proof check{item.verifications.length + (item.type === "waitFor" ? 1 : 0) === 1 ? "" : "s"}</em>}</div></div>)}
              </div>
              <details className="advanced-plan">
                <summary><Code2 size={15} /> Review or edit deterministic plan</summary>
                <p>Advanced: changes must remain valid protocol v2 JSON, preserve readiness before final evidence, and respect the selected origins.</p>
                <textarea value={planText} onChange={(event) => setCustomPlanText(event.target.value)} spellCheck={false} />
              </details>
            </div>
          )}
        </div>
        {error && <div className="form-error"><AlertTriangle size={15} /> {error}</div>}
        <div className="wizard-actions">
          <button type="button" className="secondary-button" onClick={step === 0 ? onClose : () => { setError(""); setStep((current) => current - 1); }}>{step === 0 ? "Cancel" : "Back"}</button>
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : step === 3 ? <Check size={16} /> : null}
            {step === 3 ? (specification ? "Validate and save version" : "Validate and save") : "Continue"} {step < 3 && <ArrowRight size={16} />}
          </button>
        </div>
      </form>
      {credentialDialog && (
        <CredentialDialog
          projectId={projectId}
          onClose={() => setCredentialDialog(false)}
          onSaved={(credential) => {
            onCredentialCreated(credential);
            setCredentialDialog(false);
          }}
        />
      )}
    </Modal>
  );
}

function CredentialDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (credential: Credential) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const credential = await post<Credential>(`/projects/${projectId}/credentials`, {
        name: name.trim(),
        value,
      });
      onSaved(credential);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this credential.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add protected information"
      subtitle="Available only to this project’s controlled test runs."
      onClose={onClose}
    >
      <form className="stack-form credential-form" onSubmit={submit}>
        <p className="modal-description">
          Save a test login, token, or other private value once. Scry can use it during a run
          without showing it in the Flow or report.
        </p>
        <label>
          <span>Credential name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Vitract test account password"
            minLength={2}
            maxLength={80}
            required
          />
          <small>Use a name your team will recognize. Do not put the secret itself here.</small>
        </label>
        <label>
          <span>Protected value</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Enter the actual value"
            autoComplete="new-password"
            required
          />
          <small>This value is encrypted before storage and is never returned by the API.</small>
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            <KeyRound size={18} />
            {saving ? "Saving…" : "Save credential"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
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
    <Modal title="Create project" subtitle="Create a home for related Flows, runs, and durable test history." onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="stack-form">
        <label><span>Project name</span><input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme staging" /></label>
        <label><span>Description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer-facing product journeys" /></label>
        {error && <div className="form-error"><AlertTriangle size={15} /> {error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Create project</button></div>
      </form>
    </Modal>
  );
}

function WizardSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<readonly [string, string, string?]>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find(([optionValue]) => optionValue === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="wizard-select" ref={root}>
      <button
        type="button"
        className="wizard-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.[1] ?? "Select an option"}</span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="wizard-select-menu" role="listbox">
          {options.map(([optionValue, label, description]) => (
            <button
              type="button"
              role="option"
              aria-selected={optionValue === value}
              className={optionValue === value ? "selected" : ""}
              key={optionValue || "empty"}
              onClick={() => {
                onChange(optionValue);
                setOpen(false);
              }}
            >
              <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
              {optionValue === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

function AuthenticatedArtifact({
  artifact,
  image = false,
}: {
  artifact: Report["artifacts"][number];
  image?: boolean;
}) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifact.id}`).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id]);

  if (image) {
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-disabled={!url}>
        {url ? <img src={url} alt={`Screenshot from step ${artifact.stepId ?? ""}`} /> : <div className="artifact-loading"><LoaderCircle className="spin" size={18} /></div>}
        <span><Image size={14} /> {artifact.stepId ?? "Run screenshot"} <ExternalLink size={13} /></span>
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-disabled={!url}>
      {artifact.kind === "trace" ? <Box size={16} /> : artifact.kind === "network" ? <Network size={16} /> : <FileText size={16} />}
      <span><strong>{artifact.kind}</strong><small>{formatBytes(Number(artifact.sizeBytes ?? 0))}</small></span>
      {url ? <ExternalLink size={13} /> : <LoaderCircle className="spin" size={13} />}
    </a>
  );
}

function AuthenticatedVideo({ artifact }: { artifact: Report["artifacts"][number] }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifact.id}`).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id]);

  return (
    <div className="run-recording">
      <div className="run-recording-head">
        <div><Play size={15} /><span><strong>Run recording</strong><small>Watch the complete browser journey</small></span></div>
        <span>{formatBytes(Number(artifact.sizeBytes ?? 0))}</span>
      </div>
      {url
        ? <video controls preload="metadata" src={url}>Your browser does not support WebM video.</video>
        : <div className="recording-loading"><LoaderCircle className="spin" size={20} /> Preparing recording…</div>}
    </div>
  );
}

function Metric({ label, value, detail, icon, tone = "" }: { label: string; value: string; detail: string; icon: ReactNode; tone?: string }) {
  return <div className={`metric ${tone}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
function PanelHeader({ title, kicker, action, onAction }: { title: string; kicker: string; action?: string; onAction?: () => void }) {
  return <div className="panel-head"><div><span>{kicker}</span><h2>{title}</h2></div>{action && <button onClick={onAction}>{action} <ArrowRight size={14} /></button>}</div>;
}
function PageTitle({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow lime">{eyebrow}</div><h1>{title}</h1><p>{copy}</p></div>{action}</div>;
}
function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  return <button onClick={onOpen}><div className="run-symbol">{stateIcon(run.state, 17)}</div><div className="run-primary"><strong>{run.planName || "Untitled plan"}</strong><span>Flow-scoped · {run.executionSnapshot?.viewport?.width}×{run.executionSnapshot?.viewport?.height}</span></div><span className="run-time">{relativeTime(run.createdAt)}</span><StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} /><ArrowRight size={15} /></button>;
}
function StatusBadge({ state, resolved = false }: { state: RunState; resolved?: boolean }) {
  if (resolved) return <span className="status status-resolved">resolved</span>;
  return <span className={`status status-${state}`}>{["running", "queued", "preparing", "finalizing"].includes(state) && <span className="pulse-dot" />}{humanState(state)}</span>;
}
function EmptyBlock({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div className="empty-block"><div>{icon}</div><strong>{title}</strong><span>{copy}</span></div>;
}
function InlineNotice({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div className="inline-notice">{icon}<div><strong>{title}</strong><span>{copy}</span></div><ArrowRight size={17} /></div>;
}
function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-workspace"><div className="radar large"><span /><span /><span /><Eye size={38} /></div><div className="eyebrow lime">WELCOME TO SCRY</div><h1>Give every test<br />a permanent memory.</h1><p>Create a project, then build connected Flows with their own related URLs, ordered Sequences, and durable browser evidence.</p><button className="primary-button" onClick={onCreate}><Plus size={16} /> Create first project</button></div>;
}
function BootScreen() {
  return <div className="boot"><div className="brand-mark"><Eye size={25} /></div><div className="boot-line"><span /></div><small>INITIALIZING TEST COMMAND</small></div>;
}
function PageSkeleton() {
  return <div className="skeleton-page"><div /><div /><div className="skeleton-grid"><span /><span /><span /></div><div className="skeleton-panel" /></div>;
}
function outcomeSummary(classification: Run["outcomeClassification"], detail?: string) {
  switch (classification) {
    case "readiness_timeout": return { title: "The configured ready state was not observed", copy: `${detail ?? "The readiness condition timed out."} A confirmation may show that the timeout is reproducible, but it cannot validate the expectation or prove a product defect.` };
    case "transient_observation": return { title: "Scry captured an intentional intermediate state", copy: "This evidence describes a moment in time and cannot prove the completed application state." };
    case "inconclusive_plan": return { title: "The plan did not collect conclusive proof", copy: "The observation is accurate, but the Flow did not define enough readiness or assertions for a product-level conclusion." };
    case "policy_failure": return { title: "Execution was blocked by policy", copy: detail ?? "Review the approved origins and execution boundaries." };
    case "infrastructure_failure": return { title: "The browser worker could not complete the run", copy: detail ?? "The failure occurred in Scry infrastructure rather than the tested product." };
    case "execution_timeout": return { title: "The run exceeded its execution budget", copy: detail ?? "The complete journey did not finish within its maximum duration." };
    case "confirmed_product_failure": return { title: "The expected behavior failed consistently", copy: detail ?? "Readiness succeeded and a timing-controlled confirmation reproduced the semantic assertion failure." };
    case "non_reproduced_failure": return { title: "The original observation did not reproduce", copy: "The confirmation passed with a bounded readiness window. Treat the original result as timing-sensitive." };
    case "assertion_failure": return { title: "A defined expectation was not met", copy: detail ?? "Review the failed assertion and stabilized evidence." };
    default: return { title: "The expected behavior was not observed", copy: detail ?? "Review the execution timeline and evidence." };
  }
}

function stateIcon(state: RunState, size: number) {
  if (state === "passed") return <CheckCircle2 size={size} />;
  if (["failed", "infrastructure_error", "timed_out"].includes(state)) return <XCircle size={size} />;
  if (state === "cancelled") return <Square size={size} />;
  return <LoaderCircle className="spin" size={size} />;
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
function destinationsFromFlow(specification?: Specification, environment?: Environment) {
  const destinations = (specification?.latestPlan?.steps ?? [])
    .filter((step) => step.action?.type === "navigate" && step.action.url)
    .map((step) => ({
      id: crypto.randomUUID(),
      url: step.action!.url!,
      purpose: step.title?.trim() || "Continue this Flow",
    }))
    .filter((destination, index, items) => items.findIndex((item) => item.url === destination.url) === index);
  if (destinations.length) return destinations;
  return [{
    id: crypto.randomUUID(),
    url: environment?.baseOrigin ?? "",
    purpose: environment ? "Open the application" : "",
  }];
}
function sequenceFromFlow(specification?: Specification): SequenceDraft[] {
  return (specification?.latestPlan?.steps ?? []).map((step) => {
    const action = step.action;
    const type = action?.type as SequenceActionType | undefined;
    if (!type || !["navigate", "fill", "click", "waitFor", "screenshot"].includes(type)) return undefined;
    const strategy = action?.target?.strategy;
    const targetStrategy = ["role", "label", "placeholder", "text", "testId"].includes(strategy ?? "")
      ? strategy as SequenceDraft["targetStrategy"]
      : "role";
    const role = action?.target?.role;
    const targetRole = ["button", "link", "heading", "textbox"].includes(role ?? "")
      ? role as SequenceDraft["targetRole"]
      : "button";
    const readiness = step.after?.conditions?.[0];
    const readinessType = readiness && typeof readiness.type === "string" && ["visible", "hidden", "url", "content", "request", "delay"].includes(readiness.type)
      ? readiness.type as SequenceDraft["readinessType"]
      : "settle";
    const readinessTarget = readiness?.target as { value?: string; name?: string } | undefined;
    const readinessValue = readinessType === "url"
      ? String(readiness?.expected ?? "")
      : readinessType === "request"
        ? String(readiness?.urlPattern ?? "")
        : readinessType === "delay"
          ? String(readiness?.durationMs ?? "")
          : readinessTarget?.value ?? readinessTarget?.name ?? "";
    return newSequenceAction(type, {
      title: step.title ?? "",
      url: action?.url ?? "",
      targetStrategy,
      targetRole,
      target: targetStrategy === "role" ? action?.target?.name ?? "" : action?.target?.value ?? "",
      valueMode: action?.secretRef ? "secret" : "value",
      value: action?.secretRef ?? action?.value ?? "",
      readinessType,
      readinessValue,
      readinessTimeoutMs: step.after?.timeoutMs ?? 15000,
      verifications: (step.assertions ?? [])
        .filter((assertion) => {
          if (assertion.type === "url" && assertion.match === "path" && type === "navigate") {
            return assertion.expected !== new URL(action?.url ?? "https://example.com").pathname;
          }
          return ["visible", "hidden", "url"].includes(assertion.type ?? "")
            && !(type === "waitFor" && assertion.type === "visible");
        })
        .map((assertion) => ({
          id: crypto.randomUUID(),
          type: assertion.type as VerificationDraft["type"],
          value: assertion.type === "url"
            ? assertion.expected ?? ""
            : assertion.target?.name ?? assertion.target?.value ?? "",
        })),
    });
  }).filter((step): step is SequenceDraft => Boolean(step));
}
function normalizedUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
function newSequenceAction(
  type: SequenceActionType,
  overrides: Partial<SequenceDraft> = {},
): SequenceDraft {
  return {
    id: crypto.randomUUID(),
    type,
    title: type === "navigate" ? "Open application" : type === "fill" ? "Enter value" : type === "click" ? "Continue" : type === "waitFor" ? "Verify the result" : "Capture evidence",
    url: "",
    targetStrategy: type === "fill" ? "placeholder" : "role",
    targetRole: type === "waitFor" ? "heading" : "button",
    target: "",
    valueMode: "value",
    value: "",
    verifications: [],
    readinessType: "settle",
    readinessValue: "",
    readinessTimeoutMs: 15000,
    ...overrides,
  };
}
function updateSequence(
  setSequence: Dispatch<SetStateAction<SequenceDraft[]>>,
  id: string,
  patch: Partial<SequenceDraft>,
) {
  setSequence((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
}
function updateVerification(
  setSequence: Dispatch<SetStateAction<SequenceDraft[]>>,
  actionId: string,
  verificationId: string,
  patch: Partial<VerificationDraft>,
) {
  setSequence((items) => items.map((item) => item.id === actionId
    ? {
        ...item,
        verifications: item.verifications.map((verification) =>
          verification.id === verificationId ? { ...verification, ...patch } : verification),
      }
    : item));
}
function moveItem<T>(items: T[], from: number, to: number) {
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
function environmentFor(specification: Specification, environments: Environment[]) {
  return environments.find((item) => item.name === `flow:${specification.id}`)
    ?? environments.find((item) => !item.name.startsWith("flow:"));
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function relativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function formatBytes(bytes: number) {
  if (!bytes) return "—";
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
