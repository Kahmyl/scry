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

import {
  api,
  type Flow,
  type MissionSummary,
  type Run,
  type RunState,
} from "../../infrastructure/api/client.js";
import {
  EmptyBlock,
  Metric,
  PageSkeleton,
  PageTitle,
  PanelHeader,
  stateIcon,
  StatusBadge,
} from "../../shared/components/dashboard-primitives.js";
import type { DashboardView as View } from "../../shared/state/dashboard-state.js";

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
