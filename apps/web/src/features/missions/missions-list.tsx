import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Eye,
  FileCode2,
  FileText,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  api,
  type MissionDetail,
  type MissionReport,
  type MissionSummary,
} from "../../infrastructure/api/client.js";
import {
  EmptyBlock,
  PageSkeleton,
  PageTitle,
  PanelHeader,
  StatusBadge,
} from "../../shared/components/dashboard-primitives.js";

export function Missions({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (id: string) => void;
}) {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setLoading(true);
    void api<MissionSummary[]>(`/projects/${projectId}/missions`)
      .then(setMissions)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(load, [load]);
  if (loading) return <PageSkeleton />;
  return (
    <>
      <PageTitle
        eyebrow="MISSION OBSERVATION"
        title="Missions"
        copy="Inspect instructions, objectives, executions, accepted results, and next actions. Use MCP to author or orchestrate Mission work."
      />
      {error && <div className="form-error page-form-error">{error}</div>}
      <div className="spec-grid mission-grid">
        {missions.map((m) => {
          const total = m.objectiveCount || 0;
          const done = m.terminalObjectiveCount || 0;
          return (
            <button className="spec-card mission-card" key={m.id} onClick={() => onOpen(m.id)}>
              <div className="spec-top">
                <div className="spec-icon">
                  <Eye size={19} />
                </div>
                <span className={m.status === "completed" ? "ready-tag" : "draft-tag"}>
                  {m.status.replace("_", " ")}
                </span>
              </div>
              <h3>{m.title}</h3>
              <p>{m.originalInstruction}</p>
              <div className="mission-progress">
                <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
              </div>
              <div className="spec-facts">
                <span>
                  <CheckCircle2 size={14} />
                  {done} of {total} objectives
                </span>
                <span>
                  <FileText size={14} />
                  {m.acceptedEvidenceCount} evidence
                </span>
              </div>
              <div className="spec-footer">
                <span>
                  {m.resumePointer?.explanation ?? m.lastMeaningfulActivity ?? "No pending action"}
                </span>
                <ArrowRight size={16} />
              </div>
            </button>
          );
        })}
        {!missions.length && (
          <div className="panel empty-large">
            <EmptyBlock
              icon={<Eye />}
              title="No Missions yet"
              copy="Use the Scry MCP surface to create and orchestrate the first Mission."
            />
          </div>
        )}
      </div>
    </>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
