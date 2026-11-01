import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDashed,
  FileCheck2,
  FlaskConical,
  Info,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  MonitorPlay,
  PauseCircle,
  ShieldAlert,
  Target,
  XCircle,
} from "lucide-react";
import type {
  EvidenceRef,
  ReportContentDesignProps,
  ReportDetailDesignProps,
} from "./testing-design-types.js";
export {
  MissionCollectionSurface as MissionCollectionDesign,
  ReportCollectionSurface as ReportCollectionDesign,
} from "./product-design/ProductSurfaces.js";
import "./testing-workspace.css";

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
}

const stateNames: Record<string, string> = {
  ended: "Ended",
  planning: "Planning",
  running: "In progress",
  awaiting_user: "Needs your input",
  blocked: "On hold",
  completed: "Completed",
  failed: "Ended",
  cancelled: "Cancelled",
};

const progressNames: Record<string, string> = {
  planning: "Not started",
  running: "In progress",
  awaiting_user: "Needs input",
  blocked: "On hold",
  completed: "Ended",
  failed: "Ended",
  cancelled: "Cancelled",
  skipped: "Skipped",
  passed: "Ended",
  pending: "Not started",
  final: "Final report",
  draft: "Draft report",
};

function stateName(value: string) {
  if (
    [
      "Not started",
      "In progress",
      "Needs input",
      "On hold",
      "Ended",
      "Cancelled",
      "Skipped",
    ].includes(value)
  )
    return value;
  return Object.hasOwn(stateNames, value)
    ? stateNames[value]!
    : Object.hasOwn(progressNames, value)
      ? progressNames[value]!
      : "Status unavailable";
}

function StateBadge({ state, subtle = false }: { state: string; subtle?: boolean }) {
  const Icon =
    state === "completed"
      ? CheckCircle2
      : state === "running"
        ? LoaderCircle
        : state === "awaiting_user"
          ? MessageSquareText
          : state === "blocked"
            ? PauseCircle
            : state === "failed"
              ? XCircle
              : state === "cancelled"
                ? Circle
                : CircleDashed;
  return (
    <span className={`tw-state tw-state--${state}${subtle ? " tw-state--subtle" : ""}`}>
      <Icon size={13} aria-hidden="true" />
      {stateName(state)}
    </span>
  );
}

function BackButton({ onClick, children = "Back" }: { onClick: () => void; children?: ReactNode }) {
  return (
    <button className="tw-back" onClick={onClick}>
      <ArrowLeft size={16} />
      {children}
    </button>
  );
}

export { MissionDetailDesign, JourneyEvidenceDesign } from "./MissionWorkspace.js";

function checkTone(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("different")) return "different";
  if (normalized.includes("not tested") || normalized.includes("confirmation")) return "unknown";
  return "expected";
}

function EvidenceButton({
  refs,
  onEvidence,
  children = "View evidence",
}: {
  refs: { runId: string; artifactId: string }[];
  onEvidence: (ref: EvidenceRef) => void;
  children?: ReactNode;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="tw-evidence-links">
      {refs.map((ref, index) => (
        <button
          key={`${ref.runId}-${ref.artifactId}-${index}`}
          className="tw-evidence-link"
          onClick={() => onEvidence(ref)}
        >
          <MonitorPlay size={15} />
          {children}
          {refs.length > 1 ? ` ${index + 1}` : ""}
          <ArrowUpRight size={14} />
        </button>
      ))}
    </div>
  );
}

function ReportChecks({ content, onEvidence }: ReportContentDesignProps) {
  return (
    <div className="tw-checks">
      {content.checks.map((check, index) => {
        const tone = checkTone(check.label);
        return (
          <article className={`tw-check tw-check--${tone}`} key={`${check.title}-${index}`}>
            <div className="tw-check-symbol">
              {tone === "expected" ? (
                <Check size={18} />
              ) : tone === "different" ? (
                <XCircle size={18} />
              ) : (
                <CircleDashed size={18} />
              )}
            </div>
            <div className="tw-check-body">
              <div className="tw-check-title">
                <h3>{check.title}</h3>
                <span className="tw-check-label">{check.label}</span>
              </div>
              <dl className="tw-comparison">
                {check.expected && (
                  <div>
                    <dt>Expected</dt>
                    <dd>{check.expected}</dd>
                  </div>
                )}
                <div>
                  <dt>Observed</dt>
                  <dd>{check.actual}</dd>
                </div>
              </dl>
              <EvidenceButton refs={check.evidence} onEvidence={onEvidence}>
                Review check evidence
              </EvidenceButton>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ReportObservations({ content, onEvidence }: ReportContentDesignProps) {
  if (content.observations.length === 0) return null;
  return (
    <div className="tw-observations">
      {content.observations.map((observation, index) => (
        <article className="tw-observation" key={`${observation.title}-${index}`}>
          <div className="tw-observation-mark">
            <span>{String(index + 1).padStart(2, "0")}</span>
            <Info size={17} />
          </div>
          <div>
            <h3>{observation.title}</h3>
            <p>{observation.detail}</p>
            {observation.suggestion && (
              <div className="tw-suggestion">
                <ArrowRight size={15} />
                <p>
                  <strong>Worth considering</strong>
                  {observation.suggestion}
                </p>
              </div>
            )}
            <EvidenceButton refs={observation.evidence} onEvidence={onEvidence}>
              Review supporting evidence
            </EvidenceButton>
          </div>
        </article>
      ))}
    </div>
  );
}

export function ReportContentDesign({ content, onEvidence }: ReportContentDesignProps) {
  const hasLegacyVerification = content.verified.length > 0;
  return (
    <div className="tw-report-content">
      <section id="checks" className="tw-report-section tw-check-section">
        <div className="tw-report-section-heading">
          <div className="tw-section-icon">
            <ListChecks size={19} />
          </div>
          <div>
            <p className="tw-kicker">Expected versus observed</p>
            <h2>Application checks</h2>
            <p>Direct comparisons against the intended application behaviour.</p>
          </div>
          {content.checks.length > 0 && (
            <span className="tw-section-count">{content.checks.length}</span>
          )}
        </div>
        {content.checks.length > 0 ? (
          <ReportChecks content={content} onEvidence={onEvidence} />
        ) : (
          <div className="tw-report-empty">
            <CircleDashed size={20} />
            <div>
              <h3>No structured checks in this report</h3>
              <p>
                Review the summary and individual attempts; do not infer unrecorded coverage. Any
                recorded verification, scope and limitations appear below.
              </p>
            </div>
          </div>
        )}
      </section>

      {hasLegacyVerification && (
        <section id="verification" className="tw-report-section">
          <div className="tw-report-section-heading">
            <div className="tw-section-icon tw-section-icon--neutral">
              <ListChecks size={19} />
            </div>
            <div>
              <p className="tw-kicker">From the recorded report</p>
              <h2>Recorded verification</h2>
              <p>Earlier reports may describe checks without structured comparisons.</p>
            </div>
          </div>
          <BulletList items={content.verified} />
        </section>
      )}
      {content.observations.length > 0 && (
        <section id="observations" className="tw-report-section">
          <div className="tw-report-section-heading">
            <div className="tw-section-icon tw-section-icon--amber">
              <Info size={19} />
            </div>
            <div>
              <p className="tw-kicker">Details worth a closer look</p>
              <h2>Observations</h2>
              <p>Things seen in the application that may need product or design judgement.</p>
            </div>
          </div>
          <ReportObservations content={content} onEvidence={onEvidence} />
        </section>
      )}

      <section id="context" className="tw-report-section tw-context-section">
        <div className="tw-report-section-heading">
          <div className="tw-section-icon tw-section-icon--neutral">
            <ShieldAlert size={19} />
          </div>
          <div>
            <p className="tw-kicker">Read results in context</p>
            <h2>Scope & limitations</h2>
            <p>The boundaries of this report, including what remains unknown.</p>
          </div>
        </div>
        <div className="tw-context-grid">
          <div className="tw-context-block">
            <h3>
              <Target size={16} />
              Testing scope
            </h3>
            {content.scope.length ? (
              <BulletList items={content.scope} />
            ) : (
              <p className="tw-unknown">
                No scope was recorded. The breadth of testing cannot be assumed.
              </p>
            )}
          </div>
          <div className="tw-context-block tw-context-block--limits">
            <h3>
              <ShieldAlert size={16} />
              Not verified
            </h3>
            {content.limitations.length ? (
              <BulletList items={content.limitations} />
            ) : (
              <p className="tw-unknown">
                Limitations were not specified. This does not mean that every capability or scenario
                was tested.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="tw-bullet-list">
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>
          <span />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ReportDetailDesign({
  report,
  content,
  onBack,
  onMission,
  onEvidence,
  evidence,
  evidenceRequested,
}: ReportDetailDesignProps) {
  const [contentsOpen, setContentsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("checks");
  const reportRoot = useRef<HTMLElement>(null);
  const navigationId = useId();
  const currentLabelId = useId();
  const sections = useMemo(
    () => [
      { id: "checks", label: "Application checks", Icon: ListChecks, count: content.checks.length },
      ...(content.verified.length
        ? [{ id: "verification", label: "Recorded verification", Icon: ListChecks, count: 0 }]
        : []),
      ...(content.observations.length
        ? [
            {
              id: "observations",
              label: "Observations",
              Icon: Info,
              count: content.observations.length,
            },
          ]
        : []),
      { id: "context", label: "Scope & limitations", Icon: ShieldAlert, count: 0 },
      { id: "supporting-evidence", label: "Recordings & screenshots", Icon: MonitorPlay, count: 0 },
      ...(report.originalInstruction
        ? [{ id: "original-request", label: "Original request", Icon: MessageSquareText, count: 0 }]
        : []),
    ],
    [
      content.checks.length,
      content.verified.length,
      content.observations.length,
      report.originalInstruction,
    ],
  );

  useEffect(() => {
    const root = reportRoot.current;
    if (!root) return;
    let frame: number | undefined;
    const update = () => {
      const offset =
        Number.parseFloat(getComputedStyle(root).getPropertyValue("--report-anchor-offset")) || 104;
      const targets = sections
        .map((section) => root.querySelector<HTMLElement>(`#${section.id}`))
        .filter((target): target is HTMLElement => target !== null);
      let current = targets[0]?.id ?? "checks";
      for (const target of targets) {
        if (target.getBoundingClientRect().top <= offset + 1) current = target.id;
      }
      const scroller = document.scrollingElement ?? document.documentElement;
      // A short final section may never reach the activation line before scroll ends.
      if (
        scroller.scrollTop > 0 &&
        scroller.scrollHeight - window.innerHeight - scroller.scrollTop <= 2
      ) {
        current = targets.at(-1)?.id ?? current;
      }
      setActiveSection(current);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(root);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
      observer?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [report.id, sections]);
  const activeLabel =
    sections.find((section) => section.id === activeSection)?.label ?? sections[0]!.label;
  return (
    <section className="tw-page tw-report-detail" ref={reportRoot}>
      <div className="tw-report-nav">
        <BackButton onClick={onBack}>All reports</BackButton>
        <button className="tw-mission-link" onClick={onMission}>
          <FlaskConical size={14} />
          Open mission
          <ArrowUpRight size={14} />
        </button>
      </div>
      <header className="tw-report-hero">
        <div className="tw-report-hero-label">
          <span className="tw-report-emblem">
            <FileCheck2 size={20} />
          </span>
          <p className="tw-eyebrow">Application test report</p>
          <StateBadge state={report.state} subtle />
        </div>
        <h1>{report.missionTitle}</h1>
        <p className="tw-report-summary">{report.summary}</p>
        <div className="tw-report-byline">
          <span>
            {report.finalizedAt
              ? `Finalized ${displayDate(report.finalizedAt) ?? "date unavailable"}`
              : `Created ${displayDate(report.createdAt) ?? "date unavailable"}`}
          </span>
          <span>Results about your application, with supporting evidence where available.</span>
        </div>
      </header>

      <div className="tw-report-layout">
        <aside className="tw-report-toc">
          <button
            className="tw-toc-mobile"
            onClick={() => setContentsOpen(!contentsOpen)}
            aria-expanded={contentsOpen}
            aria-controls={navigationId}
            aria-label="On this page"
            aria-describedby={currentLabelId}
          >
            <span>On this page</span>
            <span className="tw-toc-current" id={currentLabelId}>
              {activeLabel}
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <nav
            id={navigationId}
            className={contentsOpen ? "is-open" : ""}
            aria-label="Report sections"
          >
            <p>On this page</p>
            {sections.map(({ id, label, Icon, count }) => (
              <a
                key={id}
                href={`#${id}`}
                aria-current={activeSection === id ? "location" : undefined}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    setActiveSection(id);
                    setContentsOpen(false);
                  }
                }}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
                {count > 0 && <span>{count}</span>}
              </a>
            ))}
          </nav>
          <div className="tw-toc-note">
            <Info size={15} />
            <p>
              Checks describe the tested application. Mission and attempt states only describe
              testing progress.
            </p>
          </div>
        </aside>
        <div className="tw-report-main">
          <ReportContentDesign content={content} onEvidence={onEvidence} />
          <section
            id="supporting-evidence"
            className="tw-report-evidence"
            aria-label="Report evidence"
          >
            <div className="tw-evidence-stage-heading">
              <div>
                <p className="tw-kicker">
                  {evidenceRequested ? "Referenced in this report" : "Review the source material"}
                </p>
                <h2>Supporting evidence</h2>
              </div>
              <MonitorPlay size={20} />
            </div>
            {report.evidenceCoverage && (
              <p className="tw-coverage-note" role="status">
                {report.evidenceCoverage.complete} complete recording
                {report.evidenceCoverage.complete === 1 ? "" : "s"} available.
                {report.evidenceCoverage.complete < report.evidenceCoverage.runs &&
                  " Some footage is missing or incomplete. Review the available evidence alongside the stated testing gaps."}
              </p>
            )}
            {evidence}
          </section>
          {report.originalInstruction && (
            <section id="original-request" className="tw-original-request">
              <p className="tw-kicker">The brief behind this report</p>
              <h2>Original request</h2>
              <p>{report.originalInstruction}</p>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
