import { AlertTriangle, Download, Filter, Search, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, apiBlob } from "../../infrastructure/api/client.js";
import { downloadBlob } from "../../infrastructure/browser/index.js";
import {
  EmptyBlock,
  PageSkeleton,
  PageTitle,
  PanelHeader,
} from "../../shared/components/dashboard-primitives.js";

type OperationalAlert = {
  type: string;
  severity: "warning" | "critical";
  count: number;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
  safeAction: string;
};

type OperationalSummary = {
  generatedAt: string;
  windowStartedAt: string;
  totalEvents: number;
  byClassification: Record<string, number>;
  alerts: OperationalAlert[];
};

type OperationalEvent = {
  id: string;
  occurredAt: string;
  name: string;
  component: string;
  classification: string;
  reasonCode: string;
  outcome: string;
  releaseId: string;
  schemaFingerprint: string;
  durationMs?: number;
  causality: Record<string, string>;
};

type OperationalEventPage = { items: OperationalEvent[]; nextCursor?: string };

export function OperationalEventsView({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<OperationalSummary>();
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [classification, setClassification] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({ projectId, limit: "100" });
    if (classification) parameters.set("classification", classification);
    if (correlationId) parameters.set("correlationId", correlationId);
    try {
      const [nextSummary, page] = await Promise.all([
        api<OperationalSummary>(`/operations/summary?projectId=${encodeURIComponent(projectId)}`),
        api<OperationalEventPage>(`/operations/events?${parameters}`),
      ]);
      setSummary(nextSummary);
      setEvents(page.items);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [classification, correlationId, projectId]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return events;
    return events.filter((event) =>
      [event.name, event.reasonCode, event.component, ...Object.values(event.causality)]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [events, query]);

  const exportIncident = async () => {
    try {
      const parameters = new URLSearchParams({ projectId, format: "jsonl", limit: "5000" });
      if (classification) parameters.set("classification", classification);
      if (correlationId) parameters.set("correlationId", correlationId);
      const blob = await apiBlob(`/operations/events/export?${parameters}`);
      downloadBlob(blob, `scry-incident-${projectId}.jsonl`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (loading) return <PageSkeleton />;

  return (
    <>
      <PageTitle
        eyebrow="CAUSAL OPERATIONS"
        title="Operational diagnostics"
        copy="Privacy-safe internal failures, active alert conditions, and causal drill-down. Product history remains in Chronicle."
        action={
          <button className="secondary-button" onClick={() => void exportIncident()}>
            <Download size={16} /> Export incident
          </button>
        }
      />
      {error && (
        <div className="global-error">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <section className="panel operational-alert-panel">
        <PanelHeader title="Active conditions" kicker="OPERATOR ATTENTION" />
        {summary?.alerts.length ? (
          <div className="operational-alert-grid">
            {summary.alerts.map((alert) => (
              <article key={alert.type} className={`operational-alert ${alert.severity}`}>
                <ShieldAlert size={18} />
                <div>
                  <strong>{humanize(alert.type)}</strong>
                  <span>
                    {alert.count} active/recent occurrence{alert.count === 1 ? "" : "s"}
                  </span>
                  <small>{alert.safeAction}</small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyBlock
            icon={<ShieldAlert size={22} />}
            title="No active alert conditions"
            copy="The current bounded window contains no deterministic operator alerts."
          />
        )}
      </section>

      <section className="panel operational-event-panel">
        <PanelHeader
          title="Recent critical events"
          kicker={`${summary?.totalEvents ?? 0} EVENTS SINCE ${formatTime(summary?.windowStartedAt)}`}
        />
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Reason, component, or causal ID…"
            />
          </div>
          <label className="operational-filter">
            <Filter size={15} />
            <select
              value={classification}
              onChange={(event) => setClassification(event.target.value)}
            >
              <option value="">All classifications</option>
              {[
                "validation",
                "policy_refusal",
                "stale_authority",
                "application_provider",
                "infrastructure",
                "persistence",
                "reconciliation_unknown",
              ].map((value) => (
                <option key={value} value={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </label>
          {correlationId && (
            <button className="secondary-button" onClick={() => setCorrelationId("")}>
              Clear causal drill-down
            </button>
          )}
        </div>
        {visible.length ? (
          <div className="operational-events-list">
            {visible.map((event) => (
              <article key={event.id} className="operational-event-row">
                <div>
                  <span className={`operational-classification ${event.classification}`}>
                    {humanize(event.classification)}
                  </span>
                  <strong>{event.reasonCode}</strong>
                  <small>
                    {event.name} · {event.component} · {formatTime(event.occurredAt)}
                  </small>
                </div>
                <div className="operational-causality">
                  {Object.entries(event.causality)
                    .slice(0, 6)
                    .map(([key, value]) => (
                      <button
                        key={key}
                        title={`${key}: ${value}`}
                        onClick={() => key === "correlationId" && setCorrelationId(value)}
                        disabled={key !== "correlationId"}
                      >
                        {key}: {value}
                      </button>
                    ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyBlock
            icon={<Search size={22} />}
            title="No matching events"
            copy="Adjust the bounded filters or inspect another project."
          />
        )}
      </section>
    </>
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString() : "now";
}
