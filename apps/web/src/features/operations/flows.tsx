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
