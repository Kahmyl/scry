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

export function MissionReportsPage({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (id: string) => void;
}) {
  const [reports, setReports] = useState<MissionReport[]>([]);
  useEffect(() => {
    void api<MissionReport[]>(`/projects/${projectId}/mission-reports`).then(setReports);
  }, [projectId]);
  const objectiveCount = reports.reduce(
    (total, report) => total + report.snapshot.objectiveResults.length,
    0,
  );
  const acceptedRuns = new Set(
    reports.flatMap((report) =>
      report.snapshot.objectiveResults.flatMap((objective) => objective.acceptedRunIds),
    ),
  ).size;
  return (
    <div className="mission-reports-page">
      <PageTitle
        eyebrow="PUBLISHED OUTCOMES"
        title="Reports"
        copy="Final Mission conclusions, backed by explicitly accepted evidence."
      />
      {reports.length > 0 && (
        <div className="mission-report-index-summary">
          <div>
            <FileText size={18} />
            <span>
              Published reports<strong>{reports.length}</strong>
            </span>
          </div>
          <div>
            <CheckCircle2 size={18} />
            <span>
              Documented objectives<strong>{objectiveCount}</strong>
            </span>
          </div>
          <div>
            <ShieldCheck size={18} />
            <span>
              Accepted runs<strong>{acceptedRuns}</strong>
            </span>
          </div>
        </div>
      )}
      <div className="mission-report-grid">
        {reports.map((report) => {
          const objectives = report.snapshot.objectiveResults;
          const passed = objectives.filter((objective) => objective.status === "passed").length;
          const runs = new Set(objectives.flatMap((objective) => objective.acceptedRunIds)).size;
          return (
            <button
              className="mission-report-card"
              key={report.id}
              onClick={() => onOpen(report.id)}
            >
              <div className="mission-report-card-top">
                <span>
                  <FileText size={18} />
                </span>
                <div className="mission-report-card-meta">
                  <span className="mission-report-state">
                    <CheckCircle2 size={12} />
                    {report.status}
                  </span>
                  <small>{relativeTime(report.createdAt)}</small>
                </div>
              </div>
              <div className="mission-report-card-body">
                <small>Mission report · Revision {report.revision}</small>
                <h2>{report.missionTitle ?? report.snapshot.mission.title}</h2>
                <p>{report.snapshot.overallConclusion}</p>
              </div>
              <div className="mission-report-card-footer">
                <div>
                  <span>
                    {passed}/{objectives.length}
                  </span>{" "}
                  objectives passed
                </div>
                <div>
                  <span>{runs}</span> accepted run{runs === 1 ? "" : "s"}
                </div>
                <span className="mission-report-open">
                  Open report <ArrowRight size={14} />
                </span>
              </div>
            </button>
          );
        })}
        {!reports.length && (
          <div className="panel mission-reports-empty">
            <EmptyBlock
              icon={<FileText />}
              title="No Mission reports published"
              copy="A passed Run creates evidence, not a report. Publish a report explicitly from a Mission after its objectives and accepted evidence are final."
            />
          </div>
        )}
      </div>
    </div>
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
