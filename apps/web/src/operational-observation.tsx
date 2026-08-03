import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Eye,
  FileCode2,
  Gauge,
  Network,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type Flow, type MissionSummary, type Run, type RunState } from "./api.js";
import {
  EmptyBlock,
  Metric,
  PageSkeleton,
  PageTitle,
  PanelHeader,
  stateIcon,
  StatusBadge,
} from "./dashboard-primitives.js";
import type { DashboardView as View } from "./dashboard-state.js";

const terminalStates: RunState[] = [
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
];
const FLOW_PAGE_SIZE = 9;
const RUN_PAGE_SIZE = 10;

export function Overview({
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

  const reliableRuns = runs.filter((run) => run.reliabilityEligible !== false);
  const passed = reliableRuns.filter((run) => run.state === "passed").length;
  const completed = reliableRuns.filter((run) => terminalStates.includes(run.state)).length;
  const passRate = completed ? Math.round((passed / completed) * 100) : 0;
  const active = runs.filter((run) =>
    ["queued", "preparing", "running", "finalizing"].includes(run.state),
  ).length;
  const failedRuns = reliableRuns.filter((run) => run.needsAttention);
  const activeMissions = missions.filter(
    (mission) => !["completed", "cancelled", "failed"].includes(mission.status),
  ).length;
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
            <div className="onboarding-orbit">
              <Eye size={28} />
            </div>
            <div>
              <span className="eyebrow lime">GETTING STARTED</span>
              <h2>Connect an MCP agent to begin</h2>
              <p>
                The agent authors Missions, objectives, Flows, and Runs. Return here to inspect
                evidence, reports, approvals, and safety state.
              </p>
            </div>
            <button
              className="primary-button onboarding-primary"
              onClick={() => onNavigate("integrations")}
            >
              MCP setup <ArrowRight size={16} />
            </button>
          </div>
          <div className="setup-journey">
            <button className="current" onClick={() => onNavigate("integrations")}>
              <span>1</span>
              <div>
                <strong>Connect MCP</strong>
                <small>Give an intelligent client controlled access to Scry.</small>
              </div>
              <ArrowRight size={16} />
            </button>
            <button disabled>
              <span>2</span>
              <div>
                <strong>Author with the agent</strong>
                <small>Create Missions, objectives, and browser journeys through MCP.</small>
              </div>
              <ArrowRight size={16} />
            </button>
            <button disabled>
              <span>3</span>
              <div>
                <strong>Observe and approve</strong>
                <small>Inspect durable evidence and complete required human ceremonies here.</small>
              </div>
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
        action={
          <button className="primary-button" onClick={() => onNavigate("missions")}>
            <Eye size={16} /> Open Missions
          </button>
        }
      />

      {failedRuns.length > 0 && (
        <button className="attention-banner" onClick={() => onOpenReport(failedRuns[0]!.id)}>
          <span className="attention-icon">
            <AlertTriangle size={19} />
          </span>
          <span>
            <strong>
              {failedRuns.length} run{failedRuns.length === 1 ? "" : "s"} need attention
            </strong>
            <small>Open the latest failure to review the cause and captured evidence.</small>
          </span>
          <ArrowRight size={18} />
        </button>
      )}

      <section className="metric-grid metric-grid-compact">
        <Metric
          label="Active Missions"
          value={String(activeMissions)}
          detail={`${missions.length} total Missions`}
          icon={<Eye />}
          tone="lime"
        />
        <Metric
          label="Active now"
          value={String(active)}
          detail={active ? "Queued or executing" : "Nothing currently running"}
          icon={<Activity />}
          tone="lime"
        />
        <Metric
          label="Pass rate"
          value={`${passRate}%`}
          detail={`${completed} completed runs`}
          icon={<Gauge />}
          tone="lime"
        />
      </section>

      <section className="content-grid">
        <div className="panel span-2">
          <PanelHeader
            title="Recent execution"
            kicker="LATEST ACTIVITY"
            action="View all"
            onAction={() => onNavigate("runs")}
          />
          {runs.length ? (
            <div className="run-list">
              {runs.slice(0, 6).map((run) => (
                <RunRow key={run.id} run={run} onOpen={() => onOpenReport(run.id)} />
              ))}
            </div>
          ) : (
            <EmptyBlock
              icon={<Activity />}
              title="No runs yet"
              copy="Runs authored through MCP will appear here with their durable evidence."
            />
          )}
        </div>
        <div className="panel">
          <PanelHeader
            title="Recent Missions"
            kicker={`${missions.length} MISSIONS`}
            action="View all"
            onAction={() => onNavigate("missions")}
          />
          <div className="coverage-list">
            {missions.slice(0, 5).map((mission, index) => (
              <div key={mission.id}>
                <span className="coverage-index">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{mission.title}</strong>
                  <span>
                    {mission.terminalObjectiveCount} of {mission.objectiveCount} objectives resolved
                  </span>
                </div>
                {mission.status === "completed" ? <Check size={15} /> : <Clock3 size={15} />}
              </div>
            ))}
            {!missions.length && (
              <EmptyBlock
                icon={<Eye />}
                title="No Missions yet"
                copy="Missions authored through MCP will appear here."
              />
            )}
          </div>
        </div>
      </section>
    </>
  );
}

export function Flows({
  projectId,
  scopedMissionId,
  onBack,
}: {
  projectId: string;
  scopedMissionId: string;
  onBack: () => void;
}) {
  const [specs, setSpecs] = useState<Flow[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [missions, setMissions] = useState<MissionSummary[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Flow[]>(`/projects/${projectId}/flows?visibility=all`),
      api<MissionSummary[]>(`/projects/${projectId}/missions`),
    ])
      .then(([s, m]) => {
        if (!active) return;
        setSpecs(Array.isArray(s) ? s : []);
        setMissions(m);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, scopedMissionId]);

  const mission = missions.find((item) => item.id === scopedMissionId);
  const missionSpecs = specs.filter((spec) =>
    spec.missionLinks?.some((link) => link.missionId === scopedMissionId),
  );
  const visibleSpecs = missionSpecs.filter((spec) => {
    const missionNames = (spec.missionLinks ?? []).map((link) => link.missionTitle).join(" ");
    const searchable =
      `${spec.name} ${spec.latestContent?.objective ?? spec.description} ${missionNames}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase());
  });
  const pageCount = Math.max(1, Math.ceil(visibleSpecs.length / FLOW_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedSpecs = visibleSpecs.slice(
    (currentPage - 1) * FLOW_PAGE_SIZE,
    currentPage * FLOW_PAGE_SIZE,
  );

  useEffect(() => setPage(1), [projectId, query]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  return (
    <>
      <button className="back-button mission-back" onClick={onBack}>
        <ChevronLeft size={15} /> Back to Mission
      </button>
      <PageTitle
        eyebrow="MISSION FLOWS"
        title={mission?.title ?? "Flows"}
        copy="Inspect the browser journeys, ordered Sequences, and expected outcomes used by this Mission. Use MCP to author, revise, probe, publish, or run Flows."
      />
      <div className="toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Flows…"
          />
        </div>
        <div className="toolbar-meta">
          {query ? `${visibleSpecs.length} of ` : ""}
          {missionSpecs.length} in this Mission
        </div>
      </div>
      {!missions.length && (
        <div className="flow-context-empty">
          <Eye size={17} />
          <div>
            <strong>No Mission context</strong>
            <span>Mission and Flow authoring is available through MCP.</span>
          </div>
        </div>
      )}
      {error && (
        <div className="form-error page-form-error">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
      <div className="spec-grid">
        {pagedSpecs.map((spec) => (
          <article className="spec-card" key={spec.id}>
            <div className="spec-top">
              <div className="spec-icon">
                <Code2 size={19} />
              </div>
              <span className={spec.latestRevisionId ? "ready-tag" : "draft-tag"}>
                {spec.latestRevisionId ? "Executable" : "Draft"}
              </span>
            </div>
            <h3>{spec.name}</h3>
            {!!spec.missionLinks?.length && (
              <span className="flow-mission-name">
                <Eye size={12} />
                {spec.missionLinks.map((link) => link.missionTitle).join(", ")}
              </span>
            )}
            <p
              title={
                spec.latestContent?.objective ?? (spec.description || "No objective added yet.")
              }
            >
              {spec.latestContent?.objective ?? (spec.description || "No objective added yet.")}
            </p>
            <div className="spec-facts">
              <span>
                <FileCode2 size={14} /> v{spec.latestVersion ?? "—"}
              </span>
              <span>
                <Activity size={14} /> {spec.latestPlan?.steps.length ?? 0} actions
              </span>
              <span>
                <Network size={14} />{" "}
                {spec.latestPlan?.steps.filter((item) => item.action?.type === "navigate").length ??
                  0}{" "}
                destinations
              </span>
            </div>
            <div className="spec-footer spec-footer-actions">
              <span>{spec.latestContent?.expectedOutcomes?.length ?? 0} proof checks</span>
              <span className="ready-tag">Observation only</span>
            </div>
          </article>
        ))}
        {!visibleSpecs.length && (
          <div className="panel empty-large">
            <EmptyBlock
              icon={<FileCode2 />}
              title={missionSpecs.length ? "No matching Flows" : "No Flows for this Mission"}
              copy={
                missionSpecs.length
                  ? "Try a different Flow name or objective."
                  : "Flows authored through MCP will appear here for inspection."
              }
            />
          </div>
        )}
      </div>
      <Pagination
        page={currentPage}
        pageSize={FLOW_PAGE_SIZE}
        total={visibleSpecs.length}
        itemName="Flows"
        onChange={setPage}
      />
    </>
  );
}

export function Runs({
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
    if (
      filter === "running" &&
      !["queued", "preparing", "running", "finalizing"].includes(run.state)
    )
      return false;
    if (filter === "attention" && !run.needsAttention) return false;
    if (!["all", "running", "attention"].includes(filter) && run.state !== filter) return false;
    return (run.planName ?? "").toLowerCase().includes(query.toLowerCase());
  });
  const reliabilityRuns = runs.filter((run) => run.reliabilityEligible !== false);
  const activeCount = reliabilityRuns.filter((run) =>
    ["queued", "preparing", "running", "finalizing"].includes(run.state),
  ).length;
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
        <button
          className={filter === "running" ? "selected" : ""}
          onClick={() => setFilter(filter === "running" ? "all" : "running")}
        >
          <Activity size={16} />
          <span>Active</span>
          <strong>{activeCount}</strong>
        </button>
        <button
          className={filter === "attention" ? "selected attention" : "attention"}
          onClick={() => setFilter(filter === "attention" ? "all" : "attention")}
        >
          <AlertTriangle size={16} />
          <span>Needs attention</span>
          <strong>{failedCount}</strong>
        </button>
        <button
          className={filter === "passed" ? "selected" : ""}
          onClick={() => setFilter(filter === "passed" ? "all" : "passed")}
        >
          <CheckCircle2 size={16} />
          <span>Passed</span>
          <strong>{passedCount}</strong>
        </button>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by plan…"
          />
        </div>
        <div className="filter-pills">
          {["all", "running", "passed", "attention"].map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={filter === value ? "selected" : ""}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="panel table-panel">
        <div className="run-table header">
          <span>Flow</span>
          <span>Run settings</span>
          <span>Started</span>
          <span>Status</span>
          <span />
        </div>
        {pagedRuns.map((run) => (
          <button className="run-table row" key={run.id} onClick={() => onOpenReport(run.id)}>
            <span>
              <strong>{run.planName || "Untitled plan"}</strong>
              <small>
                #{run.id.slice(0, 8)} · attempt {run.attemptCount || "—"}
              </small>
            </span>
            <span>
              <strong>Flow destinations</strong>
              <small>
                {run.executionSnapshot?.viewport?.width} × {run.executionSnapshot?.viewport?.height}
              </small>
            </span>
            <span>{relativeTime(run.createdAt)}</span>
            <StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} />
            <ArrowRight size={16} />
          </button>
        ))}
        {!visible.length && (
          <EmptyBlock
            icon={<Activity />}
            title="No matching runs"
            copy="Runs will appear as soon as a plan is submitted to the execution queue."
          />
        )}
        <Pagination
          page={currentPage}
          pageSize={RUN_PAGE_SIZE}
          total={visible.length}
          itemName="runs"
          onChange={setPage}
        />
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
      <span>
        Showing {first}–{last} of {total} {itemName}
      </span>
      <div>
        <button
          type="button"
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          aria-label={`Previous ${itemName} page`}
        >
          <ChevronLeft size={15} />
        </button>
        <strong>
          Page {page} of {pageCount}
        </strong>
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          disabled={page === pageCount}
          aria-label={`Next ${itemName} page`}
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  return (
    <button onClick={onOpen}>
      <div className="run-symbol">{stateIcon(run.state, 17)}</div>
      <div className="run-primary">
        <strong>{run.planName || "Untitled plan"}</strong>
        <span>
          Flow-scoped · {run.executionSnapshot?.viewport?.width}×
          {run.executionSnapshot?.viewport?.height}
        </span>
      </div>
      <span className="run-time">{relativeTime(run.createdAt)}</span>
      <StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} />
      <ArrowRight size={15} />
    </button>
  );
}
function relativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
