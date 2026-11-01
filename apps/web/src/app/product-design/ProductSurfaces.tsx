import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Search,
  FileText,
  Layers,
  X,
  LoaderCircle,
  AlertCircle,
  Play,
  CheckCircle2,
  CircleMinus,
  CircleSlash,
  CircleHelp,
  Clock3,
  PauseCircle,
  MessageCircle,
  MonitorPlay,
  UserRound,
  Route,
  type LucideIcon,
} from "lucide-react";
import type {
  MissionCard,
  MissionCollectionDesignProps,
  ReportCollectionDesignProps,
  StatusSelectComponent,
  OverviewProps,
  RunCollectionProps,
  RunDetailProps,
} from "./types.js";
import { CustomSelect } from "../../shared/components/CustomSelect.js";
import "./product-surfaces.css";
import "./app-polish.css";
export type * from "./types.js";

/** Work states only: never infer a verdict about the tested application. */
export function workLabel(state: string): string {
  switch (state?.toLowerCase()) {
    case "planning":
    case "planned":
    case "pending":
    case "queued":
      return "Planned";
    case "running":
    case "active":
    case "in_progress":
    case "in-progress":
      return "In progress";
    case "completed":
    case "complete":
    case "ended":
    case "failed":
    case "passed":
    case "cancelled":
    case "canceled":
    case "stopped":
    case "infrastructure_error":
    case "application_failure":
    case "environment_failure":
    case "timed_out":
      return "Ended";
    case "awaiting_user":
      return "Needs input";
    case "blocked":
      return "On hold";
    default:
      return "Status unavailable";
  }
}
export function isActiveWork(state: string) {
  return workLabel(state) === "In progress";
}
export function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}
export function objectiveProgress(m: MissionCard) {
  const total = m.objectiveCount,
    ended = m.terminalObjectiveCount;
  const valid =
    Number.isSafeInteger(total) &&
    total >= 0 &&
    Number.isSafeInteger(ended) &&
    ended >= 0 &&
    ended <= total;
  return { total: valid ? total : 0, ended: valid ? ended : 0, valid };
}

const missionStates: Record<string, string> = {
  ended: "Ended",
  planning: "Planning",
  running: "In progress",
  awaiting_user: "Needs your input",
  blocked: "On hold",
  completed: "Completed",
  failed: "Ended",
  cancelled: "Cancelled",
};
const missionLabel = (state: string) =>
  Object.hasOwn(missionStates, state) ? missionStates[state]! : "Status unavailable";
// Historical execution outcomes share the customer's work-status group, not
// separate indistinguishable filter options. Persisted states stay unchanged.
const missionFilterGroup = (state: string) => (state === "failed" ? "ended" : state);
const dateValue = (value: string) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);

export function SurfaceButton({
  children,
  onClick,
  primary = false,
  disabled = false,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      disabled={disabled}
      onClick={onClick}
      className={`sp-button ${primary ? "sp-button-primary" : ""} ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}
export function SurfaceHeading({
  eyebrow,
  title,
  description,
  icon: Icon,
  tone = "lime",
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  tone?: "lime" | "blue" | "violet";
  children?: ReactNode;
}) {
  return (
    <header className={`sp-page-head sp-heading-${tone}`}>
      <div>
        {eyebrow && <p className="sp-eyebrow">{eyebrow}</p>}
        <div className="sp-title-line">
          {Icon && (
            <span className="sp-heading-mark" aria-hidden="true">
              <Icon size={22} strokeWidth={1.8} />
            </span>
          )}
          <h1>{title}</h1>
        </div>
        {description && <p className="sp-intro">{description}</p>}
      </div>
      {children}
    </header>
  );
}
export function SurfaceState({
  state,
  empty,
  title,
  body,
  onAction,
  action,
  noun = "page",
}: {
  state: "loading" | "ready" | "error";
  empty: boolean;
  title: string;
  body: string;
  onAction: () => void;
  action: string;
  noun?: string;
}) {
  if (state === "loading")
    return (
      <div className="sp-state" role="status">
        <LoaderCircle className="sp-spin" size={24} />
        <h2>Loading {noun}…</h2>
        <p>Gathering your testing work.</p>
      </div>
    );
  if (state === "error")
    return (
      <div className="sp-state" role="alert">
        <AlertCircle size={24} />
        <h2>We couldn’t load {noun}</h2>
        <p>Your testing work is unchanged. Try loading it again.</p>
        <SurfaceButton onClick={onAction}>Try again</SurfaceButton>
      </div>
    );
  if (!empty) return null;
  return (
    <div className="sp-state">
      <Layers size={28} />
      <h2>{title}</h2>
      <p>{body}</p>
      <SurfaceButton primary onClick={onAction}>
        {action}
        <ArrowRight size={16} />
      </SurfaceButton>
    </div>
  );
}
function SearchField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (s: string) => void;
  label: string;
}) {
  return (
    <div className="sp-search">
      <Search size={17} />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}
function StatusMark({ label }: { label: string }) {
  const appearance =
    label === "Completed"
      ? { tone: "complete", Icon: CheckCircle2 }
      : label === "In progress"
        ? { tone: "active", Icon: LoaderCircle }
        : label === "Ended"
          ? { tone: "ended", Icon: CircleMinus }
          : label === "Cancelled"
            ? { tone: "ended", Icon: CircleSlash }
            : label === "On hold"
              ? { tone: "attention", Icon: PauseCircle }
              : label === "Needs input" || label === "Needs your input"
                ? { tone: "attention", Icon: MessageCircle }
                : label === "Planned" || label === "Planning"
                  ? { tone: "planned", Icon: Clock3 }
                  : { tone: "unknown", Icon: CircleHelp };
  const { tone, Icon } = appearance;
  return (
    <span className={`sp-work-state sp-status-${tone}`}>
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" className="sp-status-icon" />
      {label}
    </span>
  );
}
function WorkState({ state }: { state: string }) {
  return <StatusMark label={workLabel(state)} />;
}
function MissionRow({ mission, onOpen }: { mission: MissionCard; onOpen: (id: string) => void }) {
  const p = objectiveProgress(mission);
  return (
    <article className="sp-mission-row">
      <button
        className="sp-row-hit"
        type="button"
        aria-label={`Open mission: ${mission.title}`}
        onClick={() => onOpen(mission.id)}
      />
      <div className="sp-row-copy">
        <h2>{mission.title}</h2>
        <p>{mission.originalInstruction}</p>
        <div className="sp-row-date">
          {dateValue(mission.updatedAt) ? (
            <>
              Updated <time dateTime={mission.updatedAt}>{displayDate(mission.updatedAt)}</time>
            </>
          ) : (
            "Update time unavailable"
          )}
          {mission.finalReportId && (
            <span className="sp-report-ready">
              <FileText size={13} />
              Report ready
            </span>
          )}
        </div>
      </div>
      <div className="sp-row-work">
        <StatusMark label={missionLabel(mission.state)} />
        <span>
          {!p.valid
            ? "Progress unavailable"
            : !p.total
              ? "No objectives yet"
              : `${p.ended} of ${p.total} objectives ended`}
        </span>
        <div className="sp-work-track" aria-hidden="true">
          <span style={{ width: `${p.total ? (p.ended / p.total) * 100 : 0}%` }} />
        </div>
      </div>
    </article>
  );
}
export function MissionCollectionSurface({
  missions,
  state,
  onOpen,
  onIntegrations,
  onRetry,
  StatusSelect: Select = CustomSelect,
}: MissionCollectionDesignProps & { StatusSelect?: StatusSelectComponent }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = missions
    .filter(
      (m) =>
        (status === "all" ||
          (status === "unknown"
            ? !Object.hasOwn(missionStates, m.state)
            : missionFilterGroup(m.state) === status)) &&
        `${m.title} ${m.originalInstruction}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
  const hasFilters = query !== "" || status !== "all";
  const clearFilters = () => {
    setQuery("");
    setStatus("all");
  };
  return (
    <section className="sp-surface">
      <SurfaceHeading
        eyebrow="Testing work"
        title="Missions"
        icon={Layers}
        tone="blue"
        description="The objectives your agents are working through, and the evidence they leave behind."
      />
      {state === "ready" && missions.length > 0 && (
        <>
          <div className="sp-collection-summary">
            <span>
              <strong>{missions.length}</strong> missions
            </span>
            <span>
              <strong>{missions.filter((m) => isActiveWork(m.state)).length}</strong> in progress
            </span>
            <span>
              <strong>{missions.filter((m) => m.finalReportId).length}</strong> with reports
            </span>
          </div>
          <div className="sp-toolbar">
            <SearchField value={query} onChange={setQuery} label="Search missions" />
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All statuses" },
                ...Object.entries(missionStates)
                  .filter(([value]) => missionFilterGroup(value) === value)
                  .map(([value, label]) => ({ value, label })),
                ...(missions.some((m) => !Object.hasOwn(missionStates, m.state))
                  ? [{ value: "unknown", label: "Status unavailable" }]
                  : []),
              ]}
              label="Status"
            />
          </div>
        </>
      )}
      <SurfaceState
        state={state}
        noun="missions"
        empty={!missions.length}
        title="Your first mission starts with an agent"
        body="Connect your agent, then describe what to test. Its missions and evidence will appear here."
        onAction={state === "error" ? onRetry : onIntegrations}
        action="Connect your agent"
      />
      {state === "ready" && missions.length > 0 && (
        <>
          <div className="sp-list-meta">
            <span role="status" aria-live="polite">
              {hasFilters ? `${filtered.length} of ${missions.length}` : missions.length}{" "}
              {missions.length === 1 ? "mission" : "missions"}
            </span>
            {hasFilters && <SurfaceButton onClick={clearFilters}>Clear filters</SurfaceButton>}
          </div>
          {filtered.length ? (
            <div className="sp-mission-list">
              {filtered.map((m) => (
                <MissionRow key={m.id} mission={m} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className="sp-state">
              <Search size={24} />
              <h2>No matching missions</h2>
              <p>Try another search or work state.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
export function ReportCollectionSurface({
  reports,
  state,
  onOpen,
  onMissions,
  onRetry,
}: ReportCollectionDesignProps) {
  const [query, setQuery] = useState("");
  const filtered = reports
    .filter((r) =>
      `${r.missionTitle} ${r.summary}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) => dateValue(b.finalizedAt ?? b.createdAt) - dateValue(a.finalizedAt ?? a.createdAt),
    );
  return (
    <section className="sp-surface">
      <SurfaceHeading
        eyebrow="Application findings"
        title="Reports"
        icon={FileText}
        tone="violet"
        description="Read what was checked, what was observed, and what still needs judgement."
      />
      {state === "ready" && reports.length > 0 && (
        <div className="sp-toolbar">
          <SearchField value={query} onChange={setQuery} label="Search reports" />
          <span className="sp-subtle">
            {reports.length} {reports.length === 1 ? "report" : "reports"}
          </span>
        </div>
      )}
      <SurfaceState
        state={state}
        empty={!reports.length}
        noun="reports"
        title="No reports yet"
        body="Reports bring together application checks and observations after testing. You can review mission evidence in the meantime."
        onAction={state === "error" ? onRetry : onMissions}
        action="View missions"
      />
      {state === "ready" &&
        reports.length > 0 &&
        (filtered.length ? (
          <div className="sp-report-list">
            {filtered.map((r) => (
              <button
                type="button"
                className="sp-report-row"
                key={r.id}
                aria-label={`Open report: ${r.missionTitle}`}
                onClick={() => onOpen(r.id)}
              >
                <FileText size={20} />
                <div>
                  <p className="sp-eyebrow">
                    Application test report ·{" "}
                    {r.state === "final"
                      ? "Final"
                      : r.state === "draft"
                        ? "Draft"
                        : "Status unavailable"}
                  </p>
                  <h2>{r.missionTitle}</h2>
                  <p>{r.summary}</p>
                  <time dateTime={r.finalizedAt ?? r.createdAt}>
                    {displayDate(r.finalizedAt ?? r.createdAt)}
                  </time>
                </div>
                <ArrowRight size={18} />
              </button>
            ))}
          </div>
        ) : (
          <div className="sp-state">
            <h2>No matching reports</h2>
            <SurfaceButton onClick={() => setQuery("")}>Clear search</SurfaceButton>
          </div>
        ))}
    </section>
  );
}
export function OverviewSurface({
  missions,
  runs,
  reportCount,
  onMission,
  onRun,
  onMissions,
  onRuns,
  onReports,
  onIntegrations,
}: OverviewProps) {
  const active = runs.filter((r) => isActiveWork(r.state)).length;
  const recentMissions = [...missions]
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt))
    .slice(0, 3);
  const recentRuns = [...runs]
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt))
    .slice(0, 3);
  return (
    <section className="sp-surface">
      <SurfaceHeading
        eyebrow="Project overview"
        title="Dashboard"
        icon={Layers}
        description="Describe what to test to your connected agent. Come back here for the journeys, evidence and application findings."
      />
      <div className="sp-overview-counts">
        {[
          { n: missions.length, label: "Missions", tone: "blue", icon: Layers, fn: onMissions },
          { n: active, label: "Active attempts", tone: "lime", icon: Play, fn: onRuns },
          { n: reportCount, label: "Reports", tone: "violet", icon: FileText, fn: onReports },
        ].map(({ n, label, tone, icon: Icon, fn }) => (
          <button
            type="button"
            key={label}
            className={`sp-count-card sp-count-${tone}`}
            onClick={fn}
          >
            <span className="sp-count-icon" aria-hidden="true">
              <Icon size={21} strokeWidth={1.8} />
            </span>
            <strong>{n}</strong>
            <span className="sp-count-label">{label}</span>
            <ArrowRight size={16} className="sp-count-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>
      {!missions.length ? (
        <SurfaceState
          state="ready"
          empty
          title="Start with your agent"
          body="Create a project, connect your agent, describe what to test."
          onAction={onIntegrations}
          action="Connect your agent"
        />
      ) : (
        <>
          <div className="sp-section-head">
            <h2>Recent missions</h2>
            <SurfaceButton onClick={onMissions}>
              All missions
              <ArrowRight size={15} />
            </SurfaceButton>
          </div>
          {recentMissions.map((m) => (
            <MissionRow key={m.id} mission={m} onOpen={onMission} />
          ))}
          <div className="sp-section-head">
            <h2>Recent attempts</h2>
            <SurfaceButton onClick={onRuns}>
              All runs
              <ArrowRight size={15} />
            </SurfaceButton>
          </div>
          {recentRuns.length ? (
            recentRuns.map((r) => <RunRow key={r.id} run={r} onOpen={onRun} />)
          ) : (
            <p className="sp-subtle">No attempts have started.</p>
          )}
        </>
      )}
    </section>
  );
}
function RunRow({
  run,
  onOpen,
}: {
  run: RunCollectionProps["runs"][number];
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="sp-run-row" onClick={() => onOpen(run.id)}>
      <span className="sp-run-mark" aria-hidden="true">
        <Route size={19} strokeWidth={1.8} />
      </span>
      <div>
        <h2>{run.flowName}</h2>
        <p>{run.environmentName}</p>
        <time dateTime={run.updatedAt}>Updated {displayDate(run.updatedAt)}</time>
      </div>
      <div className="sp-run-meta">
        <WorkState state={run.state} />
        <span>
          {run.artifactCount} evidence {run.artifactCount === 1 ? "item" : "items"}
        </span>
      </div>
    </button>
  );
}
export function RunCollectionSurface({
  runs,
  state,
  onOpen,
  onRetry,
  onMissions,
}: RunCollectionProps) {
  const [query, setQuery] = useState("");
  const visible = runs
    .filter((r) =>
      `${r.flowName} ${r.environmentName}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
  return (
    <section className="sp-surface">
      <SurfaceHeading
        eyebrow="Attempt history"
        title="Runs"
        icon={Route}
        tone="blue"
        description="Each run is an attempt at a journey. Its work state isn’t a verdict about your application."
      />
      {state === "ready" && runs.length > 0 && (
        <div className="sp-toolbar">
          <SearchField value={query} onChange={setQuery} label="Search journeys or environments" />
          <span className="sp-subtle">{runs.length} attempts</span>
        </div>
      )}
      <SurfaceState
        state={state}
        empty={!runs.length}
        noun="runs"
        title="No attempts yet"
        body="Your agent’s attempts will appear here with their available screenshots and recordings."
        onAction={state === "error" ? onRetry : onMissions}
        action="View missions"
      />
      {state === "ready" &&
        runs.length > 0 &&
        (visible.length ? (
          visible.map((r) => <RunRow key={r.id} run={r} onOpen={onOpen} />)
        ) : (
          <div className="sp-state">
            <h2>No matching attempts</h2>
            <SurfaceButton onClick={() => setQuery("")}>Clear search</SurfaceButton>
          </div>
        ))}
    </section>
  );
}
export function RunDetailSurface({
  run,
  evidence,
  recordingNotes,
  onBack,
  onMission,
}: RunDetailProps) {
  return (
    <section className="sp-surface">
      <nav className="sp-detail-nav">
        <SurfaceButton onClick={onBack}>
          <ArrowLeft size={15} />
          All runs
        </SurfaceButton>
        {onMission && (
          <SurfaceButton onClick={onMission}>
            Open mission
            <ArrowRight size={15} />
          </SurfaceButton>
        )}
      </nav>
      <SurfaceHeading
        eyebrow="Journey attempt"
        title={run.flowName}
        icon={MonitorPlay}
        tone="blue"
        description={run.flowPurpose}
      />
      <dl className="sp-run-facts">
        <div>
          <dt>Environment</dt>
          <dd>{run.environmentName}</dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>{run.baseOrigin}</dd>
        </div>
        <div>
          <dt>Work progress</dt>
          <dd>
            <WorkState state={run.state} />
          </dd>
        </div>
        <div>
          <dt>Available evidence</dt>
          <dd>
            {run.artifactCount} {run.artifactCount === 1 ? "item" : "items"}
          </dd>
        </div>
      </dl>
      <div className="sp-native-evidence">{evidence}</div>
      {recordingNotes.length > 0 && (
        <aside className="sp-recording-notes">
          <h2>Recording availability</h2>
          {recordingNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </aside>
      )}
    </section>
  );
}
export function AccountSurface({ email }: { email: string }) {
  return (
    <section className="sp-surface sp-narrow">
      <SurfaceHeading
        title="Account"
        description="Your identity in this workspace."
        icon={UserRound}
        tone="violet"
      />
      <dl className="sp-account">
        <dt>Signed-in email</dt>
        <dd>{email}</dd>
      </dl>
      <p className="sp-note">Authentication is managed by your configured identity provider.</p>
    </section>
  );
}
