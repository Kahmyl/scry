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
