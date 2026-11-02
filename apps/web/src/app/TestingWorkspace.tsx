import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
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
  ReportEvidenceContext,
} from "./testing-design-types.js";
export {
  MissionCollectionSurface as MissionCollectionDesign,
  ReportCollectionSurface as ReportCollectionDesign,
} from "./product-design/ProductSurfaces.js";
import "./testing-workspace.css";
import "./report-review.css";
import {
  EvidenceButton,
  ReportCheckBrowser,
  ReportOverview,
  checkGroup,
  checkSection,
  resultCategories,
  sectionFilter,
  reportSentences,
  type CheckFilter,
} from "./ReportReview.js";

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

function ReportObservations({ content, onEvidence }: ReportContentDesignProps) {
  const [page, setPage] = useState(0);
  const listId = useId();
  const currentPage = Math.min(page, Math.max(0, Math.ceil(content.observations.length / 8) - 1));
  if (content.observations.length === 0) return null;
  return (
    <>
      <div className="tw-observations">
        {content.observations
          .slice(currentPage * 8, currentPage * 8 + 8)
          .map((observation, index) => (
            <details
              className="rr-observation"
              id={`${listId}-observation-${currentPage * 8 + index}`}
              key={`${currentPage}-${observation.title}-${index}`}
              open={index === 0}
            >
              <summary>
                <Info size={17} aria-hidden="true" />
                <h3>{observation.title}</h3>
                <ChevronDown size={15} aria-hidden="true" />
              </summary>
              <div>
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
                <EvidenceButton
                  refs={observation.evidence}
                  onEvidence={onEvidence}
                  context={{
                    title: observation.title,
                    section: "observations",
                    elementId: `${listId}-observation-${currentPage * 8 + index}`,
                  }}
                >
                  View recordings & screenshots
                </EvidenceButton>
              </div>
            </details>
          ))}
      </div>
      {content.observations.length > 8 && (
        <nav className="rr-pagination" aria-label="Possible issue pages">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            Previous possible issues
          </button>
          <span>
            Page {currentPage + 1} of {Math.ceil(content.observations.length / 8)}
          </span>
          <button
            disabled={(currentPage + 1) * 8 >= content.observations.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next possible issues
          </button>
        </nav>
      )}
    </>
  );
}

export function ReportContentDesign({
  content,
  onEvidence,
  section,
  checkFilter = "all",
  checkQuery = "",
  reviewKey = 0,
  onCheckFilterChange,
}: ReportContentDesignProps & {
  section?: string;
  checkFilter?: CheckFilter;
  checkQuery?: string;
  reviewKey?: number;
  onCheckFilterChange?: (filter: CheckFilter) => void;
}) {
  const hasLegacyVerification = content.verified.length > 0;
  const category = resultCategories.find((item) => item.value === checkFilter);
  const showingChecks = !section || sectionFilter(section) !== undefined;
  return (
    <div className="tw-report-content">
      <section
        id={showingChecks && section ? section : "checks"}
        hidden={!showingChecks}
        className="tw-report-section tw-check-section"
      >
        <div className="tw-report-section-heading">
          <div className="tw-section-icon">
            <ListChecks size={19} />
          </div>
          <div>
            <p className="tw-kicker">Expected versus observed</p>
            <h2>{category?.label ?? "All test results"}</h2>
            <p>
              {category?.description ??
                "Review what each test established. A result describes the stated expectation, not the whole application."}
            </p>
          </div>
          {content.checks.length > 0 && (
            <span className="tw-section-count">
              {
                content.checks.filter(
                  (check) => checkFilter === "all" || checkGroup(check.label) === checkFilter,
                ).length
              }
            </span>
          )}
        </div>
        {content.checks.length > 0 ? (
          <ReportCheckBrowser
            key={reviewKey}
            content={content}
            onEvidence={onEvidence}
            initialFilter={checkFilter}
            {...(onCheckFilterChange
              ? { filter: checkFilter, onFilterChange: onCheckFilterChange }
              : {})}
            initialQuery={checkQuery}
          />
        ) : (
          <div className="tw-report-empty">
            <CircleDashed size={20} />
            <div>
              <h3>No individual test results in this report</h3>
              <p>
                Review the summary and individual attempts; do not infer unrecorded coverage. Any
                recorded verification, scope and limitations appear below.
              </p>
            </div>
          </div>
        )}
      </section>

      {hasLegacyVerification && (
        <section
          id="verification"
          hidden={!!section && section !== "verification"}
          className="tw-report-section"
        >
          <div className="tw-report-section-heading">
            <div className="tw-section-icon tw-section-icon--neutral">
              <ListChecks size={19} />
            </div>
            <div>
              <p className="tw-kicker">From the recorded report</p>
              <h2>Earlier test notes</h2>
              <p>Earlier reports may describe checks without structured comparisons.</p>
            </div>
          </div>
          <BulletList items={content.verified} />
        </section>
      )}
      {content.observations.length > 0 && (
        <section
          id="observations"
          hidden={!!section && section !== "observations"}
          className="tw-report-section"
        >
          <div className="tw-report-section-heading">
            <div className="tw-section-icon tw-section-icon--amber">
              <Info size={19} />
            </div>
            <div>
              <p className="tw-kicker">Details worth a closer look</p>
              <h2>Possible issues</h2>
              <p>
                These may be problems, or they may be intentional. Review them against how you want
                your application to behave; they are not confirmed defects.
              </p>
            </div>
          </div>
          <ReportObservations content={content} onEvidence={onEvidence} />
        </section>
      )}

      <section
        id="context"
        hidden={!!section && section !== "context"}
        className="tw-report-section tw-context-section"
      >
        <div className="tw-report-section-heading">
          <div className="tw-section-icon tw-section-icon--neutral">
            <ShieldAlert size={19} />
          </div>
          <div>
            <p className="tw-kicker">Read results in context</p>
            <h2>Testing coverage & gaps</h2>
            <p>
              What this assessment included, what it could not establish, and what still needs
              testing.
            </p>
          </div>
        </div>
        <div className="tw-context-grid">
          <div className="tw-context-block">
            <h3>
              <Target size={16} />
              What testing covered
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
              What remains unverified—and why
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
  const reportRoot = useRef<HTMLElement>(null);
  const [evidenceOrigin, setEvidenceOrigin] = useState<{
    reportId: string;
    context: ReportEvidenceContext;
    scrollY: number;
  }>();
  const [returnRequest, setReturnRequest] = useState<typeof evidenceOrigin>();
  const [activeSection, setActiveSection] = useState("overview");
  const [checkReview, setCheckReview] = useState<{
    filter: CheckFilter;
    query: string;
    key: number;
  }>({ filter: "all", query: "", key: 0 });
  const navigationId = useId();
  const currentLabelId = useId();
  const sections = useMemo(
    () => [
      { id: "overview", label: "Summary", Icon: FileCheck2, count: undefined },
      ...resultCategories.map((category) => ({
        id: checkSection(category.value),
        label: category.label,
        Icon:
          category.value === "expected"
            ? CheckCircle2
            : category.value === "different"
              ? XCircle
              : category.value === "uncertain"
                ? CircleDashed
                : PauseCircle,
        count: content.checks.filter((check) => checkGroup(check.label) === category.value).length,
      })),
      {
        id: "supporting-evidence",
        label: "Recordings & screenshots",
        Icon: MonitorPlay,
        count: undefined,
      },
      ...(content.observations.length
        ? [
            {
              id: "observations",
              label: "Possible issues",
              Icon: Info,
              count: content.observations.length,
            },
          ]
        : []),
      { id: "context", label: "Testing coverage & gaps", Icon: ShieldAlert, count: undefined },
      ...(content.verified.length
        ? [{ id: "verification", label: "Earlier test notes", Icon: ListChecks, count: undefined }]
        : []),
      ...(report.originalInstruction
        ? [
            {
              id: "original-request",
              label: "Original request",
              Icon: MessageSquareText,
              count: undefined,
            },
          ]
        : []),
    ],
    [
      content.checks,
      content.verified.length,
      content.observations.length,
      report.originalInstruction,
    ],
  );

  useEffect(() => {
    setCheckReview({ filter: "all", query: "", key: 0 });
    setContentsOpen(false);
    setEvidenceOrigin(undefined);
    setReturnRequest(undefined);
  }, [report.id]);

  useEffect(() => {
    const readLocation = () => {
      const id = window.location.hash.slice(1);
      const next =
        sections.some((section) => section.id === id) || id === "checks" ? id : "overview";
      setActiveSection(next);
      const filter = sectionFilter(next);
      if (filter !== undefined)
        setCheckReview((current) => (current.filter === filter ? current : { ...current, filter }));
    };
    readLocation();
    window.addEventListener("hashchange", readLocation);
    return () => window.removeEventListener("hashchange", readLocation);
  }, [report.id, sections]);
  const showSection = (id: string) => {
    setActiveSection(id);
    const filter = sectionFilter(id);
    if (filter !== undefined) setCheckReview((current) => ({ ...current, filter }));
    setContentsOpen(false);
    window.location.hash = id;
  };
  useEffect(() => {
    if (evidenceRequested) setActiveSection("supporting-evidence");
  }, [report.id, evidenceRequested]);
  const reviewEvidence = (ref: EvidenceRef, context?: ReportEvidenceContext) => {
    setEvidenceOrigin(
      context ? { reportId: report.id, context, scrollY: window.scrollY } : undefined,
    );
    showSection("supporting-evidence");
    onEvidence(ref);
  };
  useEffect(() => {
    if (
      !returnRequest ||
      returnRequest.reportId !== report.id ||
      activeSection !== returnRequest.context.section
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(returnRequest.context.elementId);
      if (element && reportRoot.current?.contains(element)) {
        window.scrollTo({ top: returnRequest.scrollY, behavior: "instant" });
        element.querySelector("summary")?.focus({ preventScroll: true });
      }
      setReturnRequest(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, report.id, returnRequest]);
  const origin = evidenceOrigin?.reportId === report.id ? evidenceOrigin : undefined;
  const summarySentences = reportSentences(report.summary);
  const summaryPreview = summarySentences.slice(0, 3).join(" ");
  const summaryRest = summarySentences.slice(3).join(" ");
  const findingContext = origin ? (
    <aside className="rr-evidence-context" aria-label="Evidence finding context">
      <div>
        <p>
          Opened from {origin.context.section === "observations" ? "possible issue" : "test result"}
        </p>
        <strong>{origin.context.title}</strong>
      </div>
      <button
        className="tw-evidence-link"
        onClick={() => {
          showSection(origin.context.section);
          setReturnRequest(origin);
        }}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        {origin.context.section === "observations"
          ? "Back to possible issue"
          : "Back to test result"}
      </button>
    </aside>
  ) : null;
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
        <p className="tw-report-summary">{summaryPreview}</p>
        {summaryRest && (
          <details className="rr-full-summary">
            <summary>More report detail</summary>
            <p>{summaryRest}</p>
          </details>
        )}
        <div className="tw-report-byline">
          <span>
            {report.finalizedAt
              ? `Finalized ${displayDate(report.finalizedAt) ?? "date unavailable"}`
              : `Created ${displayDate(report.createdAt) ?? "date unavailable"}`}
          </span>
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
            <span>Report sections</span>
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
            <p>Review your results</p>
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
                    event.preventDefault();
                    showSection(id);
                  }
                }}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
                {count !== undefined && <span>{count}</span>}
              </a>
            ))}
          </nav>
          <div className="tw-toc-note">
            <Info size={15} />
            <p>Choose a section to review the results without losing your place.</p>
          </div>
        </aside>
        <div className="tw-report-main">
          <div hidden={activeSection !== "overview"}>
            <ReportOverview
              content={content}
              onSection={showSection}
              onChecks={(filter, query = "") => {
                setCheckReview((current) => ({ filter, query, key: current.key + 1 }));
                showSection(checkSection(filter));
              }}
            />
          </div>
          <ReportContentDesign
            key={report.id}
            content={content}
            onEvidence={reviewEvidence}
            section={activeSection}
            checkFilter={checkReview.filter}
            checkQuery={checkReview.query}
            reviewKey={checkReview.key}
            onCheckFilterChange={(filter) => showSection(checkSection(filter))}
          />
          <section
            id="supporting-evidence"
            hidden={activeSection !== "supporting-evidence"}
            className="tw-report-evidence"
            aria-label="Report evidence"
          >
            <div className="tw-evidence-stage-heading">
              <div>
                <p className="tw-kicker">Review test evidence</p>
                <h2>Recordings & screenshots</h2>
                {!evidenceRequested && (
                  <p className="rr-evidence-intro">
                    Choose what was tested, then watch a recording or open a screenshot. Links from
                    a test result take you straight to its supporting evidence.
                  </p>
                )}
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
            {typeof evidence === "function" ? (
              evidence(findingContext)
            ) : (
              <>
                {findingContext}
                {evidence}
              </>
            )}
          </section>
          {report.originalInstruction && (
            <section
              id="original-request"
              hidden={activeSection !== "original-request"}
              className="tw-original-request"
            >
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
