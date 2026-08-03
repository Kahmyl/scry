import { ArrowRight, CheckCircle2, LoaderCircle, Square, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import type { RunState } from "../../infrastructure/api/client.js";

export function Metric({
  label,
  value,
  detail,
  icon,
  tone = "",
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function PanelHeader({
  title,
  kicker,
  action,
  onAction,
}: {
  title: string;
  kicker: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="panel-head">
      <div>
        <span>{kicker}</span>
        <h2>{title}</h2>
      </div>
      {action && (
        <button onClick={onAction}>
          {action} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

export function PageTitle({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow lime">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ state, resolved = false }: { state: RunState; resolved?: boolean }) {
  if (resolved) return <span className="status status-resolved">resolved</span>;
  return (
    <span className={`status status-${state}`}>
      {["running", "queued", "preparing", "finalizing"].includes(state) && (
        <span className="pulse-dot" />
      )}
      {humanState(state)}
    </span>
  );
}

export function EmptyBlock({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-block">
      <div>{icon}</div>
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="skeleton-page">
      <div />
      <div />
      <div className="skeleton-grid">
        <span />
        <span />
        <span />
      </div>
      <div className="skeleton-panel" />
    </div>
  );
}

export function stateIcon(state: RunState, size: number) {
  if (state === "passed") return <CheckCircle2 size={size} />;
  if (["failed", "infrastructure_error", "timed_out"].includes(state))
    return <XCircle size={size} />;
  if (state === "cancelled") return <Square size={size} />;
  return <LoaderCircle className="spin" size={size} />;
}

function humanState(state: string) {
  return state.replaceAll("_", " ");
}
