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
  ScanSearch,
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
  Wrench,
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
  type Calibration,
  type CredentialIncident,
  type Environment,
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
import { deriveRecordingTimeline, deriveRecoveryTimeline, type RecordingTimelineEntry } from "./recording-timeline.js";
import { dashboardPaths as viewPaths, reconcileProjectSelection, resolveDashboardView, type DashboardView as View } from "./dashboard-state.js";

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
  targetScope: "page" | "dialog" | "form" | "field_group" | "table" | "row" | "region";
  targetRole: "button" | "link" | "heading" | "textbox" | "checkbox" | "combobox" | "text" | "value";
  target: string;
  visualGrounding: boolean;
  valueMode: "value" | "secret";
  value: string;
  verifications: VerificationDraft[];
  readinessType: "visible" | "hidden" | "url" | "content" | "request" | "settle" | "delay";
  readinessValue: string;
  readinessTimeoutMs: number;
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
  const runMatch=matchPath("/dashboard/runs/:runId",location.pathname);
  const runId=runMatch?.params.runId;
  const missionFlowsMatch=matchPath("/dashboard/missions/:missionId/flows",location.pathname);
  const missionMatch=missionFlowsMatch??matchPath("/dashboard/missions/:missionId",location.pathname);
  const missionId=missionMatch?.params.missionId;
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
            <MissionReportView reportId={reportId} onBack={()=>navigate(viewPaths.reports)}/>
          ) : runId ? (
            <ReportView runId={runId} onBack={() => navigate(viewPaths.runs)} onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)} />
          ) : missionId && missionFlowsMatch ? (
            <Flows projectId={projectId} scopedMissionId={missionId} onBack={()=>navigate(`/dashboard/missions/${missionId}`)} />
          ) : missionId ? (
            <MissionDetailPage missionId={missionId} onBack={()=>navigate(viewPaths.missions)} onOpenFlows={()=>navigate(`/dashboard/missions/${missionId}/flows`)} onOpenRun={(id)=>navigate(`/dashboard/runs/${id}`)} onOpenReport={(id)=>navigate(`/dashboard/reports/${id}`)}/>
          ) : view === "missions" ? (
            <Missions projectId={projectId} onOpen={(id)=>navigate(`/dashboard/missions/${id}`)}/>
          ) : view === "overview" ? (
            <Overview projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)} onNavigate={(next) => navigate(viewPaths[next])} />
          ) : view === "runs" ? (
            <Runs projectId={projectId} onOpenReport={(id) => navigate(`/dashboard/runs/${id}`)} />
          ) : view === "reports" ? (
            <MissionReportsPage projectId={projectId} onOpen={(id)=>navigate(`/dashboard/reports/${id}`)}/>
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
    ["overview", "Dashboard", <LayoutDashboard size={17} />],
    ["missions", "Missions", <Eye size={17} />],
    ["runs", "Runs", <Activity size={17} />],
    ["reports","Reports",<FileText size={17}/>],
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

function Missions({projectId,onOpen}:{projectId:string;onOpen:(id:string)=>void}){
  const [missions,setMissions]=useState<MissionSummary[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const load=useCallback(()=>{setLoading(true);void api<MissionSummary[]>(`/projects/${projectId}/missions`).then(setMissions).catch((e)=>setError(message(e))).finally(()=>setLoading(false));},[projectId]);
  useEffect(load,[load]);if(loading)return <PageSkeleton/>;
  return <><PageTitle eyebrow="MISSION OBSERVATION" title="Missions" copy="Inspect instructions, objectives, executions, accepted results, and next actions. Use MCP to author or orchestrate Mission work."/>{error&&<div className="form-error page-form-error">{error}</div>}<div className="spec-grid mission-grid">{missions.map(m=>{const total=m.objectiveCount||0;const done=m.terminalObjectiveCount||0;return <button className="spec-card mission-card" key={m.id} onClick={()=>onOpen(m.id)}><div className="spec-top"><div className="spec-icon"><Eye size={19}/></div><span className={m.status==="completed"?"ready-tag":"draft-tag"}>{m.status.replace("_"," ")}</span></div><h3>{m.title}</h3><p>{m.originalInstruction}</p><div className="mission-progress"><span style={{width:`${total?Math.round(done/total*100):0}%`}}/></div><div className="spec-facts"><span><CheckCircle2 size={14}/>{done} of {total} objectives</span><span><FileText size={14}/>{m.acceptedEvidenceCount} evidence</span></div><div className="spec-footer"><span>{m.resumePointer?.explanation??m.lastMeaningfulActivity??"No pending action"}</span><ArrowRight size={16}/></div></button>})}{!missions.length&&<div className="panel empty-large"><EmptyBlock icon={<Eye/>} title="No Missions yet" copy="Use the Scry MCP surface to create and orchestrate the first Mission."/></div>}</div></>;
}

function CreateMissionDialog({projectId,onClose,onCreated}:{projectId:string;onClose:()=>void;onCreated:(id:string)=>void}){
  const[title,setTitle]=useState("");
  const[instruction,setInstruction]=useState("");
  const[objective,setObjective]=useState("");
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState("");
  return <Modal title="Start Mission" subtitle="Turn one instruction into an organized, resumable journey." onClose={onClose}>
    <form className="stack-form mission-create-form" onSubmit={(event)=>{
      event.preventDefault();setBusy(true);setError("");
      void post<{missionId:string;agentSessionId:string}>(`/projects/${projectId}/missions`,{title,originalInstruction:instruction,instructionSnapshot:instruction,provider:"human",idempotencyKey:`web-mission-${crypto.randomUUID()}`}).then(async created=>{
        await post(`/missions/${created.missionId}/objectives`,{missionId:created.missionId,agentSessionId:created.agentSessionId,title:objective||title,description:instruction,dependencies:[],completionCriteria:[{description:`Complete: ${objective||title}`,required:true}],order:0});onCreated(created.missionId);
      }).catch(cause=>setError(message(cause))).finally(()=>setBusy(false));
    }}>
      <div className="mission-form-intro"><span><Eye size={18}/></span><div><strong>Define the outcome</strong><small>Scry will keep every objective, Flow, Run, and accepted result connected to this Mission.</small></div></div>
      <label><span>Mission title</span><input autoFocus value={title} onChange={event=>setTitle(event.target.value)} placeholder="e.g. Verify the complete partner workflow" required/><small>A short name you can recognize later.</small></label>
      <label><span>Original instruction</span><textarea value={instruction} onChange={event=>setInstruction(event.target.value)} placeholder="Describe what Scry should accomplish and any important constraints…" required/><small>This instruction is preserved as the Mission’s source of truth.</small></label>
      <label><span>First objective <em>Optional</em></span><input value={objective} onChange={event=>setObjective(event.target.value)} placeholder="Defaults to the Mission title"/><small>You can add and organize more objectives after starting.</small></label>
      {error&&<div className="form-error"><AlertTriangle size={14}/>{error}</div>}
      <div className="modal-actions mission-form-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy?<><LoaderCircle className="spin" size={16}/> Starting…</>:<>Start Mission <ArrowRight size={16}/></>}</button></div>
    </form>
  </Modal>;
}

function MissionView({missionId,onBack,onOpenRun,onOpenReport}:{missionId:string;onBack:()=>void;onOpenRun:(id:string)=>void;onOpenReport:(id:string)=>void}){const[data,setData]=useState<MissionDetail>();const[activities,setActivities]=useState<Array<{id:string;type:string;summary:string;occurredAt:string;technical:boolean}>>([]);const[technical,setTechnical]=useState(false);const[error,setError]=useState("");const load=useCallback(()=>{void Promise.all([api<MissionDetail>(`/missions/${missionId}`),api<typeof activities>(`/missions/${missionId}/activities?technical=${technical}`)]).then(([m,a])=>{setData(m);setActivities(a);}).catch(e=>setError(message(e)));},[missionId,technical]);useEffect(load,[load]);if(!data)return <PageSkeleton/>;return <><button className="back-button" onClick={onBack}>← Back to Missions</button><PageTitle eyebrow="MISSION" title={data.title} copy={data.originalInstruction} action={<div className="page-title-actions">{data.resumePointer&&<button className="primary-button" onClick={()=>data.resumePointer?.runId?onOpenRun(data.resumePointer.runId):undefined}>Continue Mission <ArrowRight size={15}/></button>}{data.latestReportId&&<button className="secondary-button" onClick={()=>onOpenReport(data.latestReportId!)}>View report</button>}</div>}/>{error&&<div className="form-error">{error}</div>}<section className="metric-grid metric-grid-compact"><Metric label="Status" value={data.status.replace("_"," ")} detail={data.resumePointer?.explanation??"No pending resume action"} icon={<Activity/>}/><Metric label="Objectives" value={`${data.terminalObjectiveCount}/${data.objectiveCount}`} detail="Terminal outcomes" icon={<CheckCircle2/>} tone="lime"/><Metric label="Accepted evidence" value={String(data.acceptedEvidenceCount)} detail="Authoritative records" icon={<ShieldCheck/>}/></section><section className="content-grid"><div className="panel span-2"><PanelHeader title="Objectives" kicker="OUTCOME STRUCTURE"/>{data.objectives.map(o=><div className="mission-objective" key={o.id}><StatusBadge state={o.status==="passed"?"passed":o.status==="failed"?"failed":"running"}/><div><strong>{o.order+1}. {o.title}</strong><small>{o.conclusion??o.description}</small></div><span>{data.acceptedEvidence.filter(e=>e.objectiveId===o.id).length} accepted</span></div>)}</div><div className="panel"><PanelHeader title="Journey timeline" kicker="MEANINGFUL ACTIVITY" action={technical?"Hide technical":"Show technical"} onAction={()=>setTechnical(v=>!v)}/><div className="mission-timeline">{activities.map(a=><div key={a.id}><span/><div><strong>{a.summary}</strong><small>{relativeTime(a.occurredAt)}{a.technical?" · technical":""}</small></div></div>)}</div></div></section><section className="panel"><PanelHeader title="Evidence by objective" kicker="ACCEPTED SET"/>{data.objectives.map(o=><div className="evidence-group" key={o.id}><strong>{o.title}</strong>{data.acceptedEvidence.filter(e=>e.objectiveId===o.id).map(e=><button key={e.id} onClick={()=>onOpenRun(e.runId)}>Run {e.runId.slice(0,8)} · {e.conclusion}<ArrowRight size={14}/></button>)}</div>)}</section></>}

function MissionReports({projectId,onOpen}:{projectId:string;onOpen:(id:string)=>void}){const[reports,setReports]=useState<MissionReport[]>([]);useEffect(()=>{void api<MissionReport[]>(`/projects/${projectId}/mission-reports`).then(setReports)},[projectId]);return <><PageTitle eyebrow="PUBLISHED OUTCOMES" title="Reports" copy="Immutable Mission conclusions assembled from explicitly accepted evidence."/><div className="panel table-panel">{reports.map(r=><button className="run-table row" key={r.id} onClick={()=>onOpen(r.id)}><span><strong>{r.missionTitle??r.snapshot.mission.title}</strong><small>Revision {r.revision}</small></span><span>{r.snapshot.overallConclusion}</span><span>{relativeTime(r.createdAt)}</span><span className="ready-tag">{r.status}</span><ArrowRight size={16}/></button>)}{!reports.length&&<EmptyBlock icon={<FileText/>} title="No published reports" copy="Reports appear after every required objective reaches a terminal outcome."/>}</div></>}

function MissionReportView({reportId,onBack}:{reportId:string;onBack:()=>void}){
  const[report,setReport]=useState<MissionReport>();
  const[evidenceRuns,setEvidenceRuns]=useState<Record<string,Report>>({});
  const[evidenceLoading,setEvidenceLoading]=useState(false);
  const[evidenceError,setEvidenceError]=useState("");
  const[openEvidenceObjective,setOpenEvidenceObjective]=useState<string|null>(null);
  const[openEvidenceRun,setOpenEvidenceRun]=useState<string|null>(null);
  useEffect(()=>{void api<MissionReport>(`/mission-reports/${reportId}`).then(setReport)},[reportId]);
  useEffect(()=>{
    if(!report)return;
    const runIds=[...new Set(report.snapshot.objectiveResults.flatMap(objective=>objective.acceptedRunIds))];
    if(!runIds.length){setEvidenceRuns({});return;}
    let active=true;setEvidenceLoading(true);setEvidenceError("");
    void Promise.all(runIds.map(async runId=>[runId,await api<Report>(`/runs/${runId}`)] as const)).then(entries=>{if(active)setEvidenceRuns(Object.fromEntries(entries));}).catch(cause=>{if(active)setEvidenceError(message(cause));}).finally(()=>{if(active)setEvidenceLoading(false);});
    return()=>{active=false;};
  },[report]);
  if(!report)return <PageSkeleton/>;
  const snapshot=report.snapshot;
  const passed=snapshot.objectiveResults.filter(objective=>objective.status==="passed").length;
  const runCount=new Set(snapshot.objectiveResults.flatMap(objective=>objective.acceptedRunIds)).size;
  const artifactCount=new Set(snapshot.objectiveResults.flatMap(objective=>objective.acceptedArtifactIds)).size;
  return <div className="mission-report-detail">
    <button className="back-button mission-report-back" onClick={onBack}><ChevronLeft size={15}/> All reports</button>
    <section className="mission-report-hero" id="report-overview">
      <div className="mission-report-mark"><FileText size={25}/></div>
      <div className="mission-report-heading">
        <div className="mission-report-meta"><span className="mission-report-state"><CheckCircle2 size={13}/> Published</span><span>Revision {report.revision}</span><span>{relativeTime(report.createdAt)}</span></div>
        <h1>{snapshot.mission.title}</h1>
        <p>{snapshot.mission.originalInstruction}</p>
      </div>
      <div className="mission-report-conclusion"><span><CheckCircle2 size={13}/> Overall conclusion</span><h2>{snapshot.overallConclusion}</h2></div>
      <div className="mission-report-stats">
        <div><span>Objectives passed</span><strong>{passed}<small> / {snapshot.objectiveResults.length}</small></strong></div>
        <div><span>Accepted runs</span><strong>{runCount}</strong></div>
        <div><span>Evidence artifacts</span><strong>{artifactCount}</strong></div>
        <div><span>Superseded attempts</span><strong>{snapshot.supersededAttemptCount}</strong></div>
      </div>
    </section>
    <nav className="mission-report-nav" aria-label="Report sections"><a href="#report-overview"><FileText size={14}/>Overview</a><a href="#report-objectives"><CheckCircle2 size={14}/>Objectives <span>{snapshot.objectiveResults.length}</span></a><a href="#report-journey"><Activity size={14}/>Journey</a><a href="#report-evidence"><ShieldCheck size={14}/>Evidence <span>{runCount}</span></a></nav>
    <section className="mission-report-section" id="report-objectives">
      <div className="mission-report-section-head"><div><span>Accepted evidence</span><h2>Objective results</h2></div><small>{passed} of {snapshot.objectiveResults.length} passed</small></div>
      <div className="mission-report-objectives">{snapshot.objectiveResults.map((objective,index)=><article key={objective.id}>
        <div className="mission-report-objective-index">{String(index+1).padStart(2,"0")}</div>
        <div className="mission-report-objective-copy"><div><h3>{objective.title}</h3><span className={objective.status==="passed"?"mission-result-pass":"mission-result-neutral"}><CheckCircle2 size={12}/>{objective.status}</span></div><p>{objective.conclusion??"No conclusion recorded."}</p><div className="mission-report-evidence-counts"><span><Play size={12}/>{objective.acceptedRunIds.length} accepted run{objective.acceptedRunIds.length===1?"":"s"}</span><span><FileText size={12}/>{objective.acceptedArtifactIds.length} artifact{objective.acceptedArtifactIds.length===1?"":"s"}</span></div></div>
      </article>)}</div>
    </section>
    <section className="mission-report-lower" id="report-journey">
      <details className="mission-report-section mission-report-journey"><summary className="mission-report-section-head"><div><span>What happened</span><h2>Journey summary</h2></div><small>{snapshot.journeySummary.length} events <ChevronDown size={15}/></small></summary><ol>{snapshot.journeySummary.map((item,index)=><li key={`${index}-${item}`}><span>{String(index+1).padStart(2,"0")}</span><p>{item}</p></li>)}</ol></details>
      <div className="mission-report-section mission-report-actions"><div className="mission-report-section-head"><div><span>Next</span><h2>Remaining actions</h2></div></div>{snapshot.remainingActions.length?<ul>{snapshot.remainingActions.map((item,index)=><li key={`${index}-${item}`}><AlertTriangle size={15}/><span>{item}</span></li>)}</ul>:<div className="mission-report-complete"><CheckCircle2 size={24}/><strong>No remaining actions</strong><span>This Mission is complete.</span></div>}</div>
    </section>
    <section className="mission-report-section mission-report-evidence-appendix" id="report-evidence">
      <div className="mission-report-section-head"><div><span>Evidence appendix</span><h2>Accepted evidence, in reading order</h2></div><small>{runCount} accepted run{runCount===1?"":"s"}</small></div>
      {evidenceLoading&&<div className="mission-report-evidence-loading"><LoaderCircle className="spin" size={18}/> Loading accepted evidence…</div>}
      {evidenceError&&<div className="form-error mission-report-evidence-error"><AlertTriangle size={14}/>{evidenceError}</div>}
      {!evidenceLoading&&snapshot.objectiveResults.map((objective,objectiveIndex)=>{const objectiveOpen=openEvidenceObjective===objective.id;return <div className={`mission-report-evidence-objective ${objectiveOpen?"open":""}`} key={objective.id}>
        <button className="mission-report-evidence-objective-head" aria-expanded={objectiveOpen} onClick={()=>{setOpenEvidenceObjective(objectiveOpen?null:objective.id);setOpenEvidenceRun(null);}}><span>{String(objectiveIndex+1).padStart(2,"0")}</span><div><small>Objective</small><h3>{objective.title}</h3><p>{objective.conclusion}</p></div><div className="mission-report-evidence-summary"><strong>{objective.acceptedRunIds.length}</strong><small>accepted run{objective.acceptedRunIds.length===1?"":"s"}</small><em>{objectiveOpen?"Hide runs":"Explore runs"}</em>{objectiveOpen?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</div></button>
        {objectiveOpen&&<div className="mission-report-evidence-objective-body">{objective.acceptedRunIds.map((runId,runIndex)=>{const runReport=evidenceRuns[runId];if(!runReport)return null;const runOpen=openEvidenceRun===runId;const stepOrder=new Map(runReport.steps.map((step,index)=>[step.stepId,index]));const orderedArtifacts=[...runReport.artifacts].sort((left,right)=>(stepOrder.get(left.stepId??"")??Number.MAX_SAFE_INTEGER)-(stepOrder.get(right.stepId??"")??Number.MAX_SAFE_INTEGER));return <article className={`mission-report-evidence-run ${runOpen?"open":""}`} key={runId}>
          <button className="mission-report-evidence-run-head" aria-expanded={runOpen} onClick={()=>setOpenEvidenceRun(runOpen?null:runId)}><div><span className="mission-result-pass"><CheckCircle2 size={12}/>{runReport.run.state}</span><h4>Accepted Run {runIndex+1}</h4><code>{runId.slice(0,8)}</code></div><div><span>Integrity</span><strong>{runReport.integrity.status}</strong></div><div><span>Environment</span><strong>{runReport.run.environmentSnapshot.name}</strong></div><div><span>Artifacts</span><strong>{runReport.artifacts.length}</strong></div><span className="mission-report-run-toggle"><small>{runOpen?"Hide evidence":"View evidence"}</small>{runOpen?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</span></button>
          {runOpen&&<div className="mission-report-evidence-run-body"><div className="mission-report-evidence-steps">{runReport.steps.map((step,stepIndex)=><div className="mission-report-evidence-step" key={`${step.attemptId}-${step.stepId}`}><span>{String(stepIndex+1).padStart(2,"0")}</span><div><div><strong>{step.title}</strong><code>{runReport.run.planSnapshot.steps.find(candidate=>candidate.id===step.stepId)?.action.type??"step"}</code><em className={step.action.status==="passed"?"evidence-step-pass":"evidence-step-neutral"}>{step.action.status}</em></div>{step.readiness&&<small>Readiness: {step.readiness.status?.replaceAll("_"," ")}</small>}{step.assertions.length>0&&<ul>{step.assertions.map(assertion=><li key={assertion.index}><CheckCircle2 size={12}/><span>{assertion.type}</span><em>{assertion.status}</em></li>)}</ul>}</div></div>)}</div>
          {orderedArtifacts.length>0&&<div className="mission-report-run-artifacts">{orderedArtifacts.map(artifact=><div className={`mission-report-artifact mission-report-artifact-${artifact.kind}`} key={artifact.id}>{artifact.availability!=="available"?<div className="mission-report-unavailable-artifact"><ShieldCheck size={15}/><span><strong>{artifact.kind}</strong><small>{artifact.availability} · no artifact bytes exposed</small></span></div>:artifact.kind==="video"?<AuthenticatedVideo artifact={artifact}/>:artifact.kind==="screenshot"?<div className="evidence-grid"><AuthenticatedArtifact artifact={artifact} image/></div>:<div className="artifact-strip"><AuthenticatedArtifact artifact={artifact}/></div>}</div>)}</div>}</div>}
        </article>})}</div>}
      </div>})}
    </section>
  </div>;
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
  const [specs, setSpecs] = useState<Flow[]>([]);
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      api<Run[]>(`/projects/${projectId}/runs`),
      api<Flow[]>(`/projects/${projectId}/flows?visibility=all`),
      api<MissionSummary[]>(`/projects/${projectId}/missions`),
    ]).then(([nextRuns, nextSpecs, nextMissions]) => {
      setRuns(nextRuns);
      setSpecs(nextSpecs);
      setMissions(nextMissions);
      setLoading(false);
    });
  }, [projectId]);

  const reliableRuns=runs.filter(run=>run.reliabilityEligible!==false);
  const passed = reliableRuns.filter((run) => run.state === "passed").length;
  const completed = reliableRuns.filter((run) => terminalStates.includes(run.state)).length;
  const passRate = completed ? Math.round((passed / completed) * 100) : 0;
  const active = runs.filter((run) =>
    ["queued", "preparing", "running", "finalizing"].includes(run.state),
  ).length;
  const failedRuns = reliableRuns.filter((run) => run.needsAttention);
  const activeMissions = missions.filter((mission) => !["completed", "cancelled", "failed"].includes(mission.status)).length;
  const firstRunSetup = missions.length === 0 && specs.length === 0 && runs.length === 0;

  if (loading) return <PageSkeleton />;

  if (firstRunSetup) {
    return (
      <>
        <PageTitle
          eyebrow="PROJECT OVERVIEW"
          title="Dashboard"
          copy="This dashboard observes work authored and orchestrated through the Scry MCP surface."
        />
        <section className="panel onboarding-panel">
          <div className="onboarding-intro">
            <div className="onboarding-orbit"><Eye size={28} /></div>
            <div>
              <span className="eyebrow lime">GETTING STARTED</span>
              <h2>Connect an MCP agent to begin</h2>
              <p>The agent authors Missions, objectives, Flows, and Runs. Return here to inspect evidence, reports, approvals, and safety state.</p>
            </div>
            <button className="primary-button onboarding-primary" onClick={() => onNavigate("integrations")}>
              MCP setup <ArrowRight size={16} />
            </button>
          </div>
          <div className="setup-journey">
            <button className="current" onClick={() => onNavigate("integrations")}>
              <span>1</span>
              <div><strong>Connect MCP</strong><small>Give an intelligent client controlled access to Scry.</small></div>
              <ArrowRight size={16} />
            </button>
            <button disabled>
              <span>2</span>
              <div><strong>Author with the agent</strong><small>Create Missions, objectives, and browser journeys through MCP.</small></div>
              <ArrowRight size={16} />
            </button>
            <button disabled>
              <span>3</span>
              <div><strong>Observe and approve</strong><small>Inspect durable evidence and complete required human ceremonies here.</small></div>
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
        eyebrow="PROJECT OVERVIEW"
        title="Dashboard"
        copy="What needs attention, what is running, and the latest evidence from this project."
        action={<button className="primary-button" onClick={() => onNavigate("missions")}><Eye size={16} /> Open Missions</button>}
      />

      {failedRuns.length > 0 && (
        <button className="attention-banner" onClick={() => onOpenReport(failedRuns[0]!.id)}>
          <span className="attention-icon"><AlertTriangle size={19} /></span>
          <span><strong>{failedRuns.length} run{failedRuns.length === 1 ? "" : "s"} need attention</strong><small>Open the latest failure to review the cause and captured evidence.</small></span>
          <ArrowRight size={18} />
        </button>
      )}

      <section className="metric-grid metric-grid-compact">
        <Metric label="Active Missions" value={String(activeMissions)} detail={`${missions.length} total Missions`} icon={<Eye />} tone="lime" />
        <Metric label="Active now" value={String(active)} detail={active ? "Queued or executing" : "Nothing currently running"} icon={<Activity />} tone="lime" />
        <Metric label="Pass rate" value={`${passRate}%`} detail={`${completed} completed runs`} icon={<Gauge />} tone="lime" />
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
            <EmptyBlock icon={<Activity />} title="No runs yet" copy="Runs authored through MCP will appear here with their durable evidence." />
          )}
        </div>
        <div className="panel">
          <PanelHeader title="Recent Missions" kicker={`${missions.length} MISSIONS`} action="View all" onAction={() => onNavigate("missions")} />
          <div className="coverage-list">
            {missions.slice(0, 5).map((mission, index) => (
              <div key={mission.id}>
                <span className="coverage-index">{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{mission.title}</strong><span>{mission.terminalObjectiveCount} of {mission.objectiveCount} objectives resolved</span></div>
                {mission.status === "completed" ? <Check size={15} /> : <Clock3 size={15} />}
              </div>
            ))}
            {!missions.length && <EmptyBlock icon={<Eye />} title="No Missions yet" copy="Missions authored through MCP will appear here." />}
          </div>
        </div>
      </section>
    </>
  );
}

function Flows({ projectId, scopedMissionId, onBack }: { projectId: string; scopedMissionId: string; onBack: () => void }) {
  const [specs, setSpecs] = useState<Flow[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [missions,setMissions]=useState<MissionSummary[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Flow[]>(`/projects/${projectId}/flows?visibility=all`),
      api<MissionSummary[]>(`/projects/${projectId}/missions`),
    ]).then(([s,m]) => {
      if (!active) return;
      setSpecs(Array.isArray(s) ? s : []);
      setMissions(m);
    }).catch((cause) => {
      if (active) setError(message(cause));
    });
    return () => { active = false; };
  }, [projectId, scopedMissionId]);

  const mission=missions.find(item=>item.id===scopedMissionId);
  const missionSpecs=specs.filter(spec=>spec.missionLinks?.some(link=>link.missionId===scopedMissionId));
  const visibleSpecs = missionSpecs.filter((spec) => {
    const missionNames=(spec.missionLinks??[]).map(link=>link.missionTitle).join(" ");
    const searchable = `${spec.name} ${spec.latestContent?.objective ?? spec.description} ${missionNames}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase());
  });
  const pageCount = Math.max(1, Math.ceil(visibleSpecs.length / FLOW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSpecs = visibleSpecs.slice((currentPage - 1) * FLOW_PAGE_SIZE, currentPage * FLOW_PAGE_SIZE);

  useEffect(() => setPage(1), [projectId, query]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  return (
    <>
      <button className="back-button mission-back" onClick={onBack}><ChevronLeft size={15}/> Back to Mission</button>
      <PageTitle
        eyebrow="MISSION FLOWS"
        title={mission?.title??"Flows"}
        copy="Inspect the browser journeys, ordered Sequences, and expected outcomes used by this Mission. Use MCP to author, revise, probe, publish, or run Flows."
      />
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Flows…" /></div>
        <div className="toolbar-meta">{query ? `${visibleSpecs.length} of ` : ""}{missionSpecs.length} in this Mission</div>
      </div>
      {!missions.length && <div className="flow-context-empty"><Eye size={17}/><div><strong>No Mission context</strong><span>Mission and Flow authoring is available through MCP.</span></div></div>}
      {error && <div className="form-error page-form-error"><AlertTriangle size={15} /> {error}</div>}
      <div className="spec-grid">
        {pagedSpecs.map((spec) => (
          <article className="spec-card" key={spec.id}>
            <div className="spec-top">
              <div className="spec-icon"><Code2 size={19} /></div>
              <span className={spec.latestRevisionId ? "ready-tag" : "draft-tag"}>
                {spec.latestRevisionId ? "Executable" : "Draft"}
              </span>
            </div>
            <h3>{spec.name}</h3>
            {!!spec.missionLinks?.length&&<span className="flow-mission-name"><Eye size={12}/>{spec.missionLinks.map(link=>link.missionTitle).join(", ")}</span>}
            <p title={spec.latestContent?.objective ?? (spec.description || "No objective added yet.")}>{spec.latestContent?.objective ?? (spec.description || "No objective added yet.")}</p>
            <div className="spec-facts">
              <span><FileCode2 size={14} /> v{spec.latestVersion ?? "—"}</span>
              <span><Activity size={14} /> {spec.latestPlan?.steps.length ?? 0} actions</span>
              <span><Network size={14} /> {spec.latestPlan?.steps.filter((item) => item.action?.type === "navigate").length ?? 0} destinations</span>
            </div>
            <div className="spec-footer spec-footer-actions">
              <span>{spec.latestContent?.expectedOutcomes?.length ?? 0} proof checks</span>
              <span className="ready-tag">Observation only</span>
            </div>
          </article>
        ))}
        {!visibleSpecs.length && (
          <div className="panel empty-large">
            <EmptyBlock icon={<FileCode2 />} title={missionSpecs.length ? "No matching Flows" : "No Flows for this Mission"} copy={missionSpecs.length ? "Try a different Flow name or objective." : "Flows authored through MCP will appear here for inspection."} />
          </div>
        )}
      </div>
      <Pagination page={currentPage} pageSize={FLOW_PAGE_SIZE} total={visibleSpecs.length} itemName="Flows" onChange={setPage} />
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
  const reliabilityRuns=runs.filter(run=>run.reliabilityEligible!==false);
  const activeCount = reliabilityRuns.filter((run) => ["queued", "preparing", "running", "finalizing"].includes(run.state)).length;
  const failedCount = reliabilityRuns.filter((run) => run.needsAttention).length;
  const passedCount = reliabilityRuns.filter((run) => run.state === "passed").length;
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
    void api<Report>(`/runs/${runId}`).then(setReport).catch((cause) => setError(message(cause)));
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
  const currentAttempt = report.currentAttempt ?? report.attempts.at(-1);
  const allAssertions = report.steps.flatMap((step) => step.assertions);
  const passed = allAssertions.filter((assertion) => assertion.status === "passed").length;
  const failed = allAssertions.filter((assertion) => assertion.status === "failed").length;
  const screenshots = report.artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.availability === "available");
  const videos = report.artifacts.filter((artifact) => artifact.kind === "video" && artifact.availability === "available");
  const recordingTimeline = deriveRecordingTimeline(report);
  const recoveryTimeline = deriveRecoveryTimeline(report);
  const visuallyRedacted = report.artifacts.some((artifact) => artifact.observation?.visualRedaction === "protected-elements-masked");
  const degradedEvidence = report.artifacts.filter((artifact) => artifact.availability !== "available");
  const privacyEvents = report.events.filter((event) => event.type === "privacy.state_changed");
  const protectedTransactionEvents = report.events.filter((event) => ["privacy.operation_completed", "privacy.operation_failed", "privacy.credential_compromised"].includes(event.type));
  const diagnostics = report.events.filter((event) => event.type.startsWith("diagnostic."));
  const policyEvents = report.events.filter((event) => event.type === "policy.rejected");
  const fatalPolicy = [...policyEvents].reverse().find((event) => event.payload.disposition !== "blocked_subresource");
  const failedAssertion = allAssertions.find((assertion) => assertion.status === "failed");
  const failedStep = report.steps.find((step) => step.action.status === "failed" || step.readiness?.status === "failed" || step.assertions.some((assertion) => assertion.status === "failed"));
  const failureMessage = report.failure?.message ?? (fatalPolicy
    ? `${String(fatalPolicy.payload.message ?? "Request blocked by execution policy")}${fatalPolicy.payload.target ? ` · ${String(fatalPolicy.payload.target)}` : ""}`
    : currentAttempt?.error
    ?? failedAssertion?.error
    ?? failedStep?.action.error
    ?? failedStep?.readiness?.error);
  const classification = run.outcomeClassification;
  const classificationSummary = outcomeSummary(classification, failureMessage);
  const duration = currentAttempt?.startedAt && currentAttempt.completedAt
    ? new Date(currentAttempt.completedAt).getTime() - new Date(currentAttempt.startedAt).getTime()
    : undefined;

  const cancelRun = async () => {
    setBusy("cancel");
    setError("");
    try {
      await post(`/runs/${runId}/cancel`);
      load();
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
            <button className="secondary-button danger" onClick={() => void cancelRun()} disabled={!!busy}>
              <Square size={14} /> Cancel
            </button>
          )}
        </div>
      </section>
      {error && <div className="global-error"><AlertTriangle size={16} /> {error}</div>}
      <section className="panel">
        <PanelHeader title="Praxis interactions" kicker={`${report.praxis.transactions.length} TRANSACTIONS · ${report.praxis.findings.length} FINDINGS`} />
        <div className="diagnostics">
          {report.praxis.transactions.map((transaction) => <div key={transaction.transactionId}>
            <Activity size={15} />
            <div>
              <strong>{transaction.operationId} · {transaction.result.status}</strong>
              <span>{transaction.result.report.summary} · mutation {transaction.result.mutationOutcome} · {Math.round(transaction.result.timing.totalMs)} ms</span>
              {transaction.result.mutationOutcome === "unknown" && <code>Do not retry without reconciliation</code>}
            </div>
          </div>)}
          {report.praxis.findings.map(({ id, finding }) => <div key={id}>
            <AlertTriangle size={15} />
            <div><strong>{finding.code} · {finding.severity}</strong><span>{finding.remediation}</span></div>
          </div>)}
          {!report.praxis.transactions.length && !report.praxis.findings.length && <div className="clean-signal"><Eye size={20}/><strong>{report.praxis.status === "complete" ? "No Praxis records" : "Praxis records unavailable"}</strong><span>Legacy runs remain fully observable through their existing events and diagnostics.</span></div>}
        </div>
      </section>
      {report.integrity.status === "failed" && (
        <section className="failure-summary">
          <div className="failure-summary-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="eyebrow">OBSERVATION INTEGRITY</span>
            <h2>Persisted run evidence is incomplete</h2>
            <p>{report.integrity.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" · ")}</p>
          </div>
        </section>
      )}
      {(visuallyRedacted || privacyEvents.length > 0) && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><ShieldCheck size={22} /></div>
          <div>
            <span className="eyebrow">PROTECTED EVIDENCE</span>
            <h2>Evidence collection was controlled through protected intervals</h2>
            <p>Recording and trace segments stop at Privacy Gate boundaries. Suppressed or uncertain evidence is shown as a gap or metadata-only quarantine record.</p>
          </div>
        </section>
      )}
      {protectedTransactionEvents.length > 0 && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon"><ShieldCheck size={22} /></div>
          <div>
            <span className="eyebrow">PROTECTED OPERATIONS</span>
            <h2>Atomic privacy outcomes</h2>
            {protectedTransactionEvents.map((event) => (
              <div className="privacy-operation-facts" key={`${event.attemptId}-${event.sequence}`}>
                <strong>{String(event.payload.operationId ?? "protected operation")} · {String((event.payload.result as Record<string, unknown> | undefined)?.status ?? event.payload.status ?? event.payload.code ?? "completed")}</strong>
                {Boolean(event.payload.result) && <span>{["mutation", "extraction", "persistence", "capsule", "reconciliation", "continuation", "evidence", "credentialSecurity"].map((fact) => `${fact}: ${String((event.payload.result as Record<string, unknown>)[fact] ?? "unknown")}`).join(" · ")}</span>}
              </div>
            ))}
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
        <div><span>Phase</span><strong>{run.currentPhase ?? run.phase ?? run.state}</strong></div>
        <div><span>Assertions</span><strong>{passed}<small> passed</small>{failed > 0 && <em>{failed} failed</em>}</strong></div>
        <div><span>Duration</span><strong>{duration === undefined ? "—" : formatDuration(duration)}</strong></div>
        <div><span>Viewport</span><strong>{run.executionSnapshot.viewport.width} × {run.executionSnapshot.viewport.height}</strong></div>
        <div><span>Evidence</span><strong>{report.artifacts.length}<small> artifacts</small></strong></div>
        {degradedEvidence.length > 0 && <div><span>Evidence health</span><strong>{degradedEvidence.length}<small> degraded</small></strong></div>}
      </section>

      <section className="report-layout">
        <div className="report-main">
          <div className="panel">
            <PanelHeader title="Execution timeline" kicker={`${run.planSnapshot.steps.length} PLANNED STEPS`} />
            <div className="timeline">
              {run.planSnapshot.steps.map((step, index) => {
                const result = report.steps.find((candidate) => candidate.stepId === step.id);
                const failure = result && (result.action.status === "failed" || result.readiness?.status === "failed" || result.assertions.some((assertion) => assertion.status === "failed"));
                const pass = result && !failure && result.action.status === "passed";
                return (
                  <div className={`timeline-step ${failure ? "step-failed" : pass ? "step-passed" : "step-waiting"}`} key={step.id}>
                    <div className="step-rail"><span>{failure ? <X size={14} /> : pass ? <Check size={14} /> : index + 1}</span></div>
                    <div className="step-body">
                      <div><strong>{step.title}</strong><code>{step.action.type}</code></div>
                      <span>{failure ? String(result?.action.error ?? result?.readiness?.error ?? result?.assertions.find((assertion) => assertion.status === "failed")?.error ?? "Step failed") : pass ? "Completed successfully" : "Not evaluated"}</span>
                      {step.after && <div className="assertion-line"><LoaderCircle size={14} /> Readiness · {step.after.conditions.map((condition) => condition.type).join(step.after.mode === "all" ? " + " : " or ")} · up to {Math.round(step.after.timeoutMs / 1000)}s</div>}
                      {step.captureIntent === "transient" && <div className="assertion-line"><AlertTriangle size={14} /> Transient observation · not completed-state proof</div>}
                      {(result?.assertions ?? []).map((assertion) => (
                        <div className={`assertion-line assertion-${assertion.status}`} key={assertion.index}>
                          {assertion.status === "passed" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          {assertion.type} assertion · {assertion.status}
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
            {recordingTimeline.length > 0
              ? <RecordingPlaylist entries={recordingTimeline} artifacts={report.artifacts} />
              : videos.map((artifact) => <AuthenticatedVideo artifact={artifact} key={artifact.id} />)}
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
              <div><dt>Capture epochs</dt><dd>{recoveryTimeline.filter((entry) => entry.type === "capture_epoch").length || 1}</dd></div>
              {run.rerunOfRunId && <div><dt>Rerun of</dt><dd>#{run.rerunOfRunId.slice(0, 8)}</dd></div>}
              {run.resolvedByRunId && <div><dt>Resolved by</dt><dd>#{run.resolvedByRunId.slice(0, 8)}</dd></div>}
            </dl>
            {recoveryTimeline.length > 0 && (
              <div className="privacy-state-list">
                {recoveryTimeline.map((entry) => entry.type === "capture_epoch"
                  ? <div key={entry.id}><strong>Capture epoch {entry.epoch}</strong><span>{entry.startReason.replaceAll("_", " ")} → {entry.endReason.replaceAll("_", " ")}</span></div>
                  : <div key={entry.id}><strong>Checkpoint · {entry.boundary.replaceAll("_", " ")}</strong><span>{entry.reasonCode ?? entry.continuedAtStepId ?? `epoch ${entry.captureEpoch}`}</span></div>)}
              </div>
            )}
          </div>
          <div className="panel">
            <PanelHeader title="Diagnostics" kicker={`${diagnostics.length + policyEvents.length + report.praxis.transactions.length} SIGNALS`} />
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
              {!diagnostics.length && !policyEvents.length && !report.praxis.transactions.length && <div className="clean-signal"><ShieldCheck size={20} /><strong>Clean session</strong><span>No console, page, policy, Praxis, or failed-request signals.</span></div>}
            </div>
          </div>
        </aside>
      </section>
    </>
  );
}

function Settings({ projectId }: { projectId: string }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [incidents, setIncidents] = useState<CredentialIncident[]>([]);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void Promise.all([api<Credential[]>(`/projects/${projectId}/credentials`), api<Calibration[]>(`/projects/${projectId}/calibrations`), api<CredentialIncident[]>(`/projects/${projectId}/credential-incidents`)])
      .then(([nextCredentials, nextCalibrations, nextIncidents]) => { setCredentials(nextCredentials); setCalibrations(nextCalibrations); setIncidents(nextIncidents); })
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

  const decideCalibration = async (calibration: Calibration, decision: "approve" | "reject") => {
    if (!calibration.attestationId) return;
    setError("");
    try {const session=await post<{agentSessionId:string}>(`/missions/${calibration.missionId}/agent-sessions`,{provider:"human",instructionSnapshot:`${decision} calibration`,idempotencyKey:`web-calibration-${crypto.randomUUID()}`});await post(`/calibrations/${calibration.id}/attestations/${calibration.attestationId}/${decision}`,{missionId:calibration.missionId,objectiveId:calibration.objectiveId,agentSessionId:session.agentSessionId,confirmedUserAuthorized:true});load();}
    catch (cause) { setError(message(cause)); }
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
      <section className="panel credential-settings">
        <div className="credential-settings-head"><div><span className="eyebrow">PRIVACY CALIBRATION</span><h3>Protected-operation contracts</h3><p>Structural fingerprints and adapter choices remain inactive until an owner or admin approves the immutable revision.</p></div></div>
        <div className="credential-list">
          {calibrations.map((calibration) => <div key={calibration.id}><span className="credential-icon"><ShieldCheck size={17} /></span><div><strong>{calibration.name}</strong><small>{calibration.operationId} · revision {calibration.revision} · {calibration.status} · session {calibration.sessionState ?? "pending"}{calibration.safeDiagnostics?.phase ? ` · ${calibration.safeDiagnostics.phase}` : ""}{calibration.safeDiagnostics?.stepId ? ` · step ${calibration.safeDiagnostics.stepId}` : ""}{calibration.safeDiagnostics?.code ? ` · ${calibration.safeDiagnostics.code}` : ""}</small></div>{calibration.status === "draft" && calibration.attestationId && <><button className="secondary-button" onClick={() => void decideCalibration(calibration, "reject")}>Reject</button><button className="primary-button" onClick={() => void decideCalibration(calibration, "approve")}>Approve</button></>}</div>)}
          {!calibrations.length && <EmptyBlock icon={<ShieldCheck />} title="No calibration contracts" copy="Agents may create disposable calibration drafts through MCP; approval remains here." />}
        </div>
      </section>
      <section className="panel credential-settings">
        <div className="credential-settings-head"><div><span className="eyebrow">CREDENTIAL RESPONSE</span><h3>Credential incidents</h3><p>Compromised credentials never reactivate. Failed or timed-out revocation requires manual action.</p></div></div>
        <div className="credential-list">
          {incidents.map((incident) => <div key={incident.id}><span className="credential-icon"><AlertTriangle size={17} /></span><div><strong>{incident.operationId}</strong><small>{incident.state} · {incident.reasonCode} · {incident.safeDiagnostics?.code ?? "INCIDENT_RECORDED"} · {relativeTime(incident.createdAt)}</small>{incident.safeDiagnostics?.manualAction && <small>Required action: revoke this credential in the provider administration console.</small>}</div></div>)}
          {!incidents.length && <EmptyBlock icon={<ShieldCheck />} title="No credential incidents" copy="Revocation outcomes and manual follow-up will appear here." />}
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

function FlowDialog({
  projectId,
  flow,
  environment,
  credentials,
  onCredentialCreated,
  onClose,
  onCreated,
  getContext,
}: {
  projectId: string;
  flow?: Flow | undefined;
  environment?: Environment | undefined;
  credentials: Credential[];
  onCredentialCreated: (credential: Credential) => void;
  onClose: () => void;
  onCreated: () => void;
  getContext:()=>Promise<{missionId:string;objectiveId:string;agentSessionId:string}>;
}) {
  const initialDestinations = destinationsFromFlow(flow, environment);
  const initialSequence = sequenceFromFlow(flow);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(flow?.name ?? "");
  const [objective, setObjective] = useState(flow?.latestContent?.objective ?? flow?.description ?? "");
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
  const targetFor = (action: SequenceDraft) => ({ concept: action.target.trim(), requiredCapabilities: action.type === "fill" ? ["focusable","accepts_text","editable"] : action.type === "click" ? ["pointer_activatable"] : ["readable_value"], preferredEvidence: { roles: [action.targetRole], names: [action.target.trim()], labels: action.targetRole === "textbox" || action.targetRole === "combobox" ? [action.target.trim()] : [], descriptions: [], placeholders: action.targetRole === "textbox" ? [action.target.trim()] : [], inputTypes: action.valueMode === "secret" ? ["password"] : [], ...(action.visualGrounding?{visual:{sources:["ocr","geometry"],expectedText:action.target.trim(),protectedUse:false}}:{}) }, scope: { kind: action.targetScope }, relations: [], prohibited: ["hidden","disabled",...(action.type === "fill" ? ["readonly","display_only_text"] : [])], risk: action.valueMode === "secret" ? "authentication" : "ordinary", confidence: { requiredFamilies: [], minimumFamilyCount: action.valueMode === "secret" ? 3 : 2 } });
  const textIntent = (value:string, role:"text"|"region"="text") => ({concept:value.trim(),requiredCapabilities:["readable_value"],preferredEvidence:{roles:[role],names:[value.trim()],labels:[],descriptions:[],placeholders:[],inputTypes:[],expectedText:value.trim()},scope:{kind:"page" as const},relations:[],prohibited:["hidden"],risk:"read_only" as const,confidence:{requiredFamilies:[],minimumFamilyCount:1}});
  const readinessFor = (action: SequenceDraft) => {
    if (!["navigate", "click"].includes(action.type)) return undefined;
    const timeoutMs = action.readinessTimeoutMs;
    if (action.readinessType === "visible" || action.readinessType === "hidden") {
      return { mode: "all", timeoutMs, conditions: [{ type: action.readinessType, target: textIntent(action.readinessValue) }] };
    }
    if (action.readinessType === "url") {
      return { mode: "all", timeoutMs, conditions: [{ type: "url", expected: action.readinessValue, match: "contains" }] };
    }
    if (action.readinessType === "content") {
      return { mode: "all", timeoutMs, conditions: [{ type: "content", target: textIntent(action.readinessValue,"region"), minimumChildren: 1 }] };
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
              target: textIntent(verification.value.trim()),
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
      return { ...base, action: { type: "click", target: targetFor(item), expectedEffect: item.readinessType === "url" ? {type:"navigation",url:item.readinessValue,match:"contains"} : {type:"none"} } };
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
    name: name.trim() || "Untitled journey",
    objective: objective.trim() || "Verify the selected user journey.",
    preconditions: [],
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
      const context=await getContext();
      const plan = JSON.parse(planText);
      const environmentInput = {
        ...context,
        baseOrigin: allowedOrigins[0],
        policy: {
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
      const selectedEnvironment = environment
        ? await patch<Environment>(`/environments/${environment.id}`, environmentInput)
        : await post<Environment>(`/projects/${projectId}/environments`, {
            ...environmentInput,
            name: `flow:${crypto.randomUUID()}`,
          });
      const content = { objective, expectedOutcomes: outcomes, preconditions: [], prohibitedSideEffects: [] };
      if (flow) {
        if (!flow.latestRevisionId) throw new Error("Flow has no current revision.");
        await post(`/flows/${flow.id}/revisions`, {
          ...context,reason:"Dashboard Flow revision",
          environmentId: selectedEnvironment.id,
          expectedRevisionId: flow.latestRevisionId,
          name,
          description: objective,
          content,
          plan,
          idempotencyKey: `web-revision-${crypto.randomUUID()}`,
        });
      } else {
        await post(`/projects/${projectId}/flows`, {
          ...context,visibility:"reusable",purpose:"primary",reason:"Dashboard Flow creation",
          environmentId: selectedEnvironment.id,
          name,
          description: objective,
          content,
          plan,
          idempotencyKey: `web-flow-${crypto.randomUUID()}`,
        });
      }
      onCreated();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={flow ? "Edit Flow" : "Create Flow"} subtitle={`Step ${step + 1} of 4 · ${["Describe the journey", "Add related pages", "Add instructions and proof", "Review and save"][step]}`} onClose={onClose} wide>
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
                            <summary>Refine capability and evidence</summary>
                            <p>Scry first requires a control that can perform the action. Roles, names, layout, and OCR are supporting evidence—not mandatory page markup.</p>
                            <div className="capability-summary"><strong>Required behavior</strong><span>{action.type === "fill" ? "Focusable · accepts text · editable" : action.type === "click" ? "Pointer or keyboard activation" : "Readable visible state"}</span></div>
                            <div className="sequence-target-grid">
                              <label><span>Preferred semantic evidence</span><WizardSelect value={action.targetRole} options={[["button", "Button-like"], ["link", "Link-like"], ["heading", "Heading-like"], ["textbox", "Text-field-like"], ["checkbox", "Toggle-like"], ["combobox", "Selection-control-like"], ["text", "Visible text"], ["value", "Displayed value"]]} onChange={(value) => updateSequence(setSequence, action.id, { targetRole: value as SequenceDraft["targetRole"] })} /></label>
                              <label><span>Search within</span><WizardSelect value={action.targetScope} options={[["page", "Whole page"], ["dialog", "Open dialog"], ["form", "Form"], ["field_group", "Field group"], ["table", "Table"], ["row", "Table row"], ["region", "Named region"]]} onChange={(value) => updateSequence(setSequence, action.id, { targetScope: value as SequenceDraft["targetScope"] })} /></label>
                            </div>
                            <label className="checkbox-row"><input type="checkbox" checked={action.visualGrounding} onChange={(event)=>updateSequence(setSequence,action.id,{visualGrounding:event.target.checked})}/><span><strong>Add local visual evidence</strong><small>Fuse local OCR anchors and geometry with browser control capabilities. Visual evidence never becomes an action target by itself.</small></span></label>
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
                                <span>{action.readinessType === "url" ? "Address should contain" : action.readinessType === "content" ? "Section name or description" : action.readinessType === "request" ? "Request URL should contain" : action.readinessType === "delay" ? "Delay in milliseconds" : "Words on the page"}</span>
                                <input
                                  value={action.readinessValue}
                                  onChange={(event) => updateSequence(setSequence, action.id, { readinessValue: event.target.value })}
                                  placeholder={action.readinessType === "url" ? "/dashboard" : action.readinessType === "content" ? "API documentation" : action.readinessType === "request" ? "/api/orders" : action.readinessType === "delay" ? "1000" : "Run POST"}
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
                <p>Advanced: changes must remain valid current-plan JSON, preserve readiness before final evidence, and respect the selected origins.</p>
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
            {step === 3 ? (flow ? "Validate and save revision" : "Validate and save") : "Continue"} {step < 3 && <ArrowRight size={16} />}
          </button>
        </div>
      </form>
      {credentialDialog && (
        <CredentialDialog
          projectId={projectId}
          getContext={getContext}
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
  getContext,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (credential: Credential) => void;
  getContext?:()=>Promise<{missionId:string;objectiveId:string;agentSessionId:string}>;
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
      if(!getContext) throw new Error("Select a Mission objective before creating protected information.");
      const context=await getContext();
      const credential = await post<Credential>(`/projects/${projectId}/credentials`, {
        ...context,
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
    if (artifact.availability !== "available") return;
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifact.id}`).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id]);

  if (artifact.availability === "quarantined" || artifact.availability === "destroyed") {
    return <div className="artifact-quarantined"><ShieldCheck size={16} /><span><strong>{artifact.kind} quarantined</strong><small>Uncertain bytes were destroyed · {String(artifact.observation?.reasonCode ?? "PRIVACY_UNCERTAIN")}</small></span></div>;
  }

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
        ? <EvidenceVideo src={url} label="Play run recording" />
        : <div className="recording-loading"><LoaderCircle className="spin" size={20} /> Preparing recording…</div>}
    </div>
  );
}

function EvidenceVideo({ src, label }: { src: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setPlaying(false), [src]);

  const play = () => {
    const result = videoRef.current?.play();
    if (result) void result.catch(() => setPlaying(false));
  };

  return (
    <div className="recording-video-stage">
      <video
        ref={videoRef}
        controls
        preload="metadata"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      >Your browser does not support WebM video.</video>
      {!playing && (
        <button className="recording-play-overlay" type="button" aria-label={label} onClick={play}>
          <Play size={30} fill="currentColor" />
        </button>
      )}
    </div>
  );
}

export function RecordingPlaylist({ entries, artifacts }: { entries: RecordingTimelineEntry[]; artifacts: Report["artifacts"] }) {
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const entry = entries[index];
  const artifact = entry?.type === "video_segment" && entry.artifactId
    ? artifacts.find((candidate) => candidate.id === entry.artifactId)
    : undefined;
  const entryId = entry?.id;
  const entryType = entry?.type;
  const entryStatus = entry?.type === "video_segment" ? entry.status : undefined;
  const artifactId = artifact?.id;

  const advance = useCallback(() => setIndex((current) => Math.min(current + 1, entries.length - 1)), [entries.length]);

  useEffect(() => {
    setUrl(undefined);
    setLoadFailed(false);
    if (entryType !== "video_segment" || entryStatus !== "available" || !artifactId) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifactId}`).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {
      if (!disposed) setLoadFailed(true);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, entryId, entryStatus, entryType]);

  if (!entry) return null;
  const durationMs = "endedAt" in entry && "startedAt" in entry
    ? Math.max(0, new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime())
    : 0;
  return (
    <div className="run-recording">
      <div className="run-recording-head">
        <div><Play size={15} /><span><strong>Run recording</strong><small>Segment {index + 1} of {entries.length}</small></span></div>
        <div className="recording-segment-nav">
          <button type="button" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0}><ChevronLeft size={16} /> Previous</button>
          <span>{formatDuration(durationMs)}</span>
          <button type="button" onClick={advance} disabled={index === entries.length - 1}>Next <ChevronRight size={16} /></button>
        </div>
      </div>
      {entry.type === "video_segment" && entry.status === "available" && url && !loadFailed && (
        <EvidenceVideo src={url} label={`Play recording segment ${index + 1}`} />
      )}
      {entry.type === "video_segment" && entry.status === "available" && !url && !loadFailed && (
        <div className="recording-loading"><LoaderCircle className="spin" size={20} /> Preparing segment…</div>
      )}
      {entry.type === "protected_gap" && (
        <div className="recording-gap"><ShieldCheck size={24} /><strong>Protected operation</strong><span>Visual capture was suspended for this interval.</span></div>
      )}
      {(entry.type === "unavailable_interval" || entry.type === "video_segment" && (entry.status !== "available" || loadFailed)) && (
        <div className="recording-gap recording-unavailable"><AlertTriangle size={24} /><strong>Recording interval unavailable</strong><span>{entry.type === "unavailable_interval" ? entry.failureCode : entry.failureCode ?? "SEGMENT_UNAVAILABLE"}</span></div>
      )}
      <div className="recording-playlist-controls">
        <span>{entries.map((item, itemIndex) => <i className={itemIndex === index ? "active" : ""} key={item.id} />)}</span>
      </div>
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
function MissionReportsPage({projectId,onOpen}:{projectId:string;onOpen:(id:string)=>void}){
  const[reports,setReports]=useState<MissionReport[]>([]);
  useEffect(()=>{void api<MissionReport[]>(`/projects/${projectId}/mission-reports`).then(setReports)},[projectId]);
  const objectiveCount=reports.reduce((total,report)=>total+report.snapshot.objectiveResults.length,0);
  const acceptedRuns=new Set(reports.flatMap(report=>report.snapshot.objectiveResults.flatMap(objective=>objective.acceptedRunIds))).size;
  return <div className="mission-reports-page"><PageTitle eyebrow="PUBLISHED OUTCOMES" title="Reports" copy="Final Mission conclusions, backed by explicitly accepted evidence."/>{reports.length>0&&<div className="mission-report-index-summary"><div><FileText size={18}/><span>Published reports<strong>{reports.length}</strong></span></div><div><CheckCircle2 size={18}/><span>Documented objectives<strong>{objectiveCount}</strong></span></div><div><ShieldCheck size={18}/><span>Accepted runs<strong>{acceptedRuns}</strong></span></div></div>}<div className="mission-report-grid">{reports.map(report=>{const objectives=report.snapshot.objectiveResults;const passed=objectives.filter(objective=>objective.status==="passed").length;const runs=new Set(objectives.flatMap(objective=>objective.acceptedRunIds)).size;return <button className="mission-report-card" key={report.id} onClick={()=>onOpen(report.id)}><div className="mission-report-card-top"><span><FileText size={18}/></span><div className="mission-report-card-meta"><span className="mission-report-state"><CheckCircle2 size={12}/>{report.status}</span><small>{relativeTime(report.createdAt)}</small></div></div><div className="mission-report-card-body"><small>Mission report · Revision {report.revision}</small><h2>{report.missionTitle??report.snapshot.mission.title}</h2><p>{report.snapshot.overallConclusion}</p></div><div className="mission-report-card-footer"><div><span>{passed}/{objectives.length}</span> objectives passed</div><div><span>{runs}</span> accepted run{runs===1?"":"s"}</div><span className="mission-report-open">Open report <ArrowRight size={14}/></span></div></button>})}{!reports.length&&<div className="panel mission-reports-empty"><EmptyBlock icon={<FileText/>} title="No Mission reports published" copy="A passed Run creates evidence, not a report. Publish a report explicitly from a Mission after its objectives and accepted evidence are final."/></div>}</div></div>;
}

function MissionDetailPage({missionId,onBack,onOpenFlows,onOpenRun,onOpenReport}:{missionId:string;onBack:()=>void;onOpenFlows:()=>void;onOpenRun:(id:string)=>void;onOpenReport:(id:string)=>void}){
  const[data,setData]=useState<MissionDetail>();
  const[activities,setActivities]=useState<Array<{id:string;type:string;summary:string;occurredAt:string;technical:boolean}>>([]);
  const[technical,setTechnical]=useState(false);
  const[error,setError]=useState("");
  const[authoringOpen,setAuthoringOpen]=useState(false);
  const load=useCallback(()=>{void Promise.all([api<MissionDetail>(`/missions/${missionId}`),api<typeof activities>(`/missions/${missionId}/activities?technical=${technical}`)]).then(([mission,nextActivities])=>{setData(mission);setActivities(nextActivities);}).catch(cause=>setError(message(cause)));},[missionId,technical]);
  useEffect(load,[load]);
  if(!data)return <PageSkeleton/>;
  const statusLabel=data.status.replaceAll("_"," ");
  const statusTone=data.status==="completed"?"success":["failed","blocked"].includes(data.status)?"danger":"active";
  return <div className="mission-detail">
    <button className="back-button mission-back" onClick={onBack}><ChevronLeft size={15}/> Back to Missions</button>
    <section className={`mission-hero mission-hero-${statusTone}`}>
      <div className="mission-hero-copy"><div className="mission-hero-meta"><span className={`mission-status mission-status-${statusTone}`}>{statusLabel}</span><span>{data.terminalObjectiveCount} of {data.objectiveCount} objectives resolved</span></div><h1>{data.title}</h1><p>{data.originalInstruction}</p></div>
      <div className="page-title-actions"><button className="secondary-button" onClick={onOpenFlows}><FileCode2 size={15}/> Flows ({data.flows.length})</button>{data.resumePointer?.runId&&<button className="secondary-button" onClick={()=>onOpenRun(data.resumePointer!.runId!)}>Inspect current Run <ArrowRight size={15}/></button>}{data.latestReportId&&<button className="secondary-button" onClick={()=>onOpenReport(data.latestReportId!)}>View report</button>}</div>
      <div className="mission-summary-strip"><div><span>Progress</span><strong>{data.terminalObjectiveCount}/{data.objectiveCount}</strong></div><div><span>Accepted evidence</span><strong>{data.acceptedEvidenceCount}</strong></div><div className="mission-next-action"><span>Next action</span><strong>{data.resumePointer?.explanation??"No pending action"}</strong></div></div>
    </section>
    {error&&<div className="form-error">{error}</div>}
    <section className="mission-detail-grid">
      <div className="panel mission-objectives-panel"><PanelHeader title="Objectives" kicker="OUTCOMES"/><div className="mission-objective-list">{data.objectives.map(objective=>{const accepted=data.acceptedEvidence.filter(evidence=>evidence.objectiveId===objective.id);const awaiting=objective.orchestrationState==="awaiting_evidence";return <article className="mission-objective-card" key={objective.id}><div className="mission-objective-index">{String(objective.order+1).padStart(2,"0")}</div><div><div className="mission-objective-title"><strong>{objective.title}</strong>{awaiting?<span className="draft-tag">awaiting evidence</span>:<StatusBadge state={objective.status==="passed"?"passed":objective.status==="failed"?"failed":"running"}/>}</div><p>{objective.conclusion??objective.description}</p><span>{accepted.length?`${accepted.length} accepted evidence record${accepted.length===1?"":"s"}`:awaiting?"Candidate Run ready for review":"No evidence accepted yet"}</span></div></article>})}</div></div>
      <div className="panel mission-journey-panel"><PanelHeader title="Journey" kicker="MEANINGFUL ACTIVITY" action={technical?"Hide technical":"Show technical"} onAction={()=>setTechnical(current=>!current)}/><div className="mission-timeline">{activities.map(activity=><div key={activity.id}><span/><div><strong>{activity.summary}</strong><small>{relativeTime(activity.occurredAt)}{activity.technical?" · technical":""}</small></div></div>)}</div></div>
    </section>
    {data.authoring.length>0&&<section className="panel mission-authoring-panel"><button className="mission-authoring-toggle" onClick={()=>setAuthoringOpen(value=>!value)} aria-expanded={authoringOpen}><span><Wrench size={17}/><span><small>AUTHORING ACTIVITY</small><strong>{data.authoring.reduce((total,draft)=>total+draft.probes.length,0)} Probe Session{data.authoring.reduce((total,draft)=>total+draft.probes.length,0)===1?"":"s"}</strong></span></span><span>Drafts, calibration, and compilation do not count as failed Runs <ChevronDown className={authoringOpen?"expanded":""} size={18}/></span></button>{authoringOpen&&<div className="mission-authoring-list">{data.authoring.map(draft=><article key={draft.id}><div><strong>{draft.name}</strong><span>Draft v{draft.version} · {draft.state.replaceAll("_"," ")}</span></div><div className="mission-authoring-pills"><span>{draft.probes.length} probes</span><span>{draft.compilations[0]?.status?.replaceAll("_"," ")??"not compiled"}</span></div>{draft.probes.map(probe=><div className="mission-authoring-probe" key={probe.id}><span>{probe.level.replaceAll("_"," ")}</span><strong>{probe.state}</strong><small>{probe.result?.allResolved===true?"All contracts resolved":probe.result?.diagnostics?.length?`${probe.result.diagnostics.length} authoring issue${probe.result.diagnostics.length===1?"":"s"}`:"Awaiting diagnostic result"}</small></div>)}</article>)}</div>}</section>}
    <section className="panel mission-evidence-panel"><PanelHeader title="Accepted evidence" kicker="AUTHORITATIVE SET"/>{data.acceptedEvidence.length?<div className="mission-evidence-list">{data.acceptedEvidence.map(evidence=>{const objective=data.objectives.find(candidate=>candidate.id===evidence.objectiveId);return <button key={evidence.id} onClick={()=>onOpenRun(evidence.runId)}><span><small>{objective?.title??"Objective"}</small><strong>{evidence.conclusion}</strong></span><span>Run {evidence.runId.slice(0,8)} <ArrowRight size={14}/></span></button>})}</div>:<EmptyBlock icon={<ShieldCheck/>} title="No accepted evidence yet" copy="Candidate Runs remain reviewable and do not become Mission conclusions until explicitly accepted."/>}</section>
  </div>;
}

function EditMissionDialog({mission,busy,onClose,onSave}:{mission:MissionDetail;busy:boolean;onClose:()=>void;onSave:(values:{title:string;originalInstruction:string})=>void}){const[title,setTitle]=useState(mission.title);const[instruction,setInstruction]=useState(mission.originalInstruction);return <Modal title="Edit Mission" subtitle="Correct this Mission instead of creating replacement work." onClose={onClose}><form className="stack-form" onSubmit={event=>{event.preventDefault();onSave({title,originalInstruction:instruction});}}><label><span>Mission title</span><input value={title} onChange={event=>setTitle(event.target.value)} required/></label><label><span>Original instruction</span><textarea value={instruction} onChange={event=>setInstruction(event.target.value)} required/></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy?<LoaderCircle className="spin" size={15}/>:<Pencil size={15}/>} Save Mission</button></div></form></Modal>}

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
function destinationsFromFlow(flow?: Flow, environment?: Environment) {
  const destinations = (flow?.latestPlan?.steps ?? [])
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
function sequenceFromFlow(flow?: Flow): SequenceDraft[] {
  return (flow?.latestPlan?.steps ?? []).map((step) => {
    const action = step.action;
    const type = action?.type as SequenceActionType | undefined;
    if (!type || !["navigate", "fill", "click", "waitFor", "screenshot"].includes(type)) return undefined;
    const role = action?.target?.preferredEvidence?.roles?.[0];
    const targetRole = ["button", "link", "heading", "textbox", "checkbox", "combobox", "text", "value"].includes(role ?? "")
      ? role as SequenceDraft["targetRole"]
      : "button";
    const scopeKind=action?.target?.scope?.kind; const targetScope=["page","dialog","form","field_group","table","row","region"].includes(scopeKind??"")?scopeKind as SequenceDraft["targetScope"]:"page";
    const readiness = step.after?.conditions?.[0];
    const readinessType = readiness && typeof readiness.type === "string" && ["visible", "hidden", "url", "content", "request", "delay"].includes(readiness.type)
      ? readiness.type as SequenceDraft["readinessType"]
      : "settle";
    const readinessTarget = readiness?.target as { preferredEvidence?: { names?: string[]; expectedText?: string }; concept?: string } | undefined;
    const readinessValue = readinessType === "url"
      ? String(readiness?.expected ?? "")
      : readinessType === "request"
        ? String(readiness?.urlPattern ?? "")
        : readinessType === "delay"
          ? String(readiness?.durationMs ?? "")
          : readinessTarget?.preferredEvidence?.expectedText ?? readinessTarget?.preferredEvidence?.names?.[0] ?? readinessTarget?.concept ?? "";
    return newSequenceAction(type, {
      title: step.title ?? "",
      url: action?.url ?? "",
      targetScope,
      targetRole,
      target: action?.target?.preferredEvidence?.names?.[0] ?? action?.target?.concept ?? action?.target?.preferredEvidence?.labels?.[0] ?? "",
      visualGrounding: Boolean(action?.target?.preferredEvidence?.visual),
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
            : assertion.target?.preferredEvidence?.names?.[0] ?? assertion.target?.concept ?? "",
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
    targetScope: "page",
    targetRole: type === "waitFor" ? "heading" : "button",
    target: "",
    visualGrounding: false,
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
function environmentFor(flow: Flow, environments: Environment[]) {
  return environments.find((item) => item.name === `flow:${flow.id}`)
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
