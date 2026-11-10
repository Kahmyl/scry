import { useEffect, useId, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  Check,
  CircleDashed,
  MonitorPlay,
  Search,
  XCircle,
} from "lucide-react";
import type { ReportEvidenceContext, ReportContentDesignProps } from "./testing-design-types.js";

/** A verbatim, word-bounded excerpt, not an inferred or AI-authored conclusion. */
export function reportExcerpt(value: string, limit = 200): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const start = text.slice(0, limit);
  return `${start.replace(/\s+\S*$/, "") || start}…`;
}
/** Keep complete authored sentences where truncation could change a conclusion. */
export function reportSentences(value: string): string[] {
  return Array.from(
    new Intl.Segmenter("en", { granularity: "sentence" }).segment(value),
    ({ segment }) => segment.trim(),
  ).filter(Boolean);
}
export function resultLabel(value: string): string {
  return resultCategories.find((item) => item.value === checkGroup(value))!.label;
}

export type CheckFilter =
  "all" | "different" | "expected" | "uncertain" | "not-tested" | "blocked" | "excluded";
export function checkGroup(label: string): Exclude<CheckFilter, "all"> {
  if (["Different from expected", "Didn’t work as expected"].includes(label)) return "different";
  if (["As expected", "Worked as expected"].includes(label)) return "expected";
  if (label === "Blocked") return "blocked";
  if (label === "Excluded") return "excluded";
  return label === "Not tested" ? "not-tested" : "uncertain";
}
export const resultCategories: Array<{
  value: Exclude<CheckFilter, "all">;
  label: string;
  description: string;
}> = [
  {
    value: "blocked",
    label: "Blocked",
    description:
      "These checks could not proceed. Read the missing prerequisite and what is needed to finish.",
  },
  {
    value: "excluded",
    label: "Excluded",
    description: "These checks were deliberately outside the authorized scope.",
  },
  {
    value: "expected",
    label: "Worked as expected",
    description:
      "These tests produced the expected result. Read each comparison to see exactly what was confirmed.",
  },
  {
    value: "different",
    label: "Didn’t work as expected",
    description:
      "These tests did not produce the expected result. Each entry shows what should have happened and what happened instead.",
  },
  {
    value: "uncertain",
    label: "Couldn’t confirm",
    description:
      "These tests did not establish a clear result. Read the recorded explanation before drawing a conclusion.",
  },
  {
    value: "not-tested",
    label: "Not tested",
    description:
      "These tests were not carried out. Read the recorded reason and any remaining testing gaps.",
  },
];
const filters = [{ value: "all" as const, label: "All results" }, ...resultCategories];

export function checkSection(filter: CheckFilter): string {
  return filter === "all" ? "checks" : `checks-${filter}`;
}
export function sectionFilter(section: string): CheckFilter | undefined {
  return section === "checks"
    ? "all"
    : resultCategories.find((item) => checkSection(item.value) === section)?.value;
}

export function EvidenceButton({
  refs,
  onEvidence,
  children = "View evidence",
  context,
}: {
  refs: Array<{ runId: string; artifactId: string }>;
  onEvidence: ReportContentDesignProps["onEvidence"];
  children?: ReactNode;
  context?: ReportEvidenceContext;
}) {
  return refs.length ? (
    <div className="tw-evidence-links">
      {refs.map((ref, index) => (
        <button
          key={`${ref.runId}-${ref.artifactId}-${index}`}
          className="tw-evidence-link"
          onClick={() => (context ? onEvidence(ref, context) : onEvidence(ref))}
        >
          <MonitorPlay size={15} aria-hidden="true" />
          {children}
          {refs.length > 1 ? ` ${index + 1}` : ""}
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  ) : null;
}

/** Compact, bounded results; expanding a row never changes its evidence reference. */
export function ReportCheckBrowser({
  content,
  onEvidence,
  initialFilter = "all",
  initialQuery = "",
  filter: controlledFilter,
  onFilterChange,
}: ReportContentDesignProps & {
  initialFilter?: CheckFilter;
  initialQuery?: string;
  filter?: CheckFilter;
  onFilterChange?: (filter: CheckFilter) => void;
}) {
  const [localFilter, setLocalFilter] = useState<CheckFilter>(initialFilter);
  const filter = controlledFilter ?? localFilter;
  const setFilter = (next: CheckFilter) => {
    setLocalFilter(next);
    onFilterChange?.(next);
  };
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter]);
  const listId = useId();
  const matching = content.checks.filter(
    (check) =>
      (filter === "all" || checkGroup(check.label) === filter) &&
      `${check.title} ${check.expected ?? ""} ${check.actual}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const pageSize = 8;
  const lastPage = Math.max(0, Math.ceil(matching.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * pageSize;
  return (
    <>
      <div className="rr-check-tools">
        <label className="rr-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search test results"
            placeholder="Find a test or result…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <div className="rr-filters" aria-label="Filter test results">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => {
                setFilter(item.value);
                setPage(0);
              }}
            >
              {item.label}
              <span>
                {item.value === "all"
                  ? content.checks.length
                  : content.checks.filter((check) => checkGroup(check.label) === item.value).length}
              </span>
            </button>
          ))}
        </div>
      </div>
      <p className="rr-result-count" role="status">
        {matching.length
          ? `${start + 1}–${Math.min(start + pageSize, matching.length)} of ${matching.length} ${matching.length === 1 ? "test" : "tests"}`
          : "No tests match these filters"}
      </p>
      {!matching.length && (
        <button
          className="tw-evidence-link"
          onClick={() => {
            setQuery("");
            setFilter("all");
            setPage(0);
          }}
        >
          Clear filters
        </button>
      )}
      <div className="rr-check-list" key={`${filter}-${query}-${currentPage}`}>
        {matching.slice(start, start + pageSize).map((check, index) => {
          const elementId = `${listId}-check-${content.checks.indexOf(check)}`;
          const category = checkGroup(check.label);
          const tone =
            category === "different"
              ? "different"
              : category === "expected"
                ? "expected"
                : "unknown";
          return (
            <details
              className={`rr-check tw-check--${tone}`}
              id={elementId}
              key={`${check.title}-${index}`}
              open={index === 0}
            >
              <summary>
                <span className="tw-check-symbol" aria-hidden="true">
                  {tone === "expected" ? (
                    <Check size={16} />
                  ) : tone === "different" ? (
                    <XCircle size={16} />
                  ) : (
                    <CircleDashed size={16} />
                  )}
                </span>
                <div className="rr-check-caption">
                  <h3>{check.title}</h3>
                  <span className="rr-check-preview">{reportExcerpt(check.actual, 170)}</span>
                </div>
                <span className="tw-check-label">{resultLabel(check.label)}</span>
                <ChevronDown className="rr-disclosure" size={15} aria-hidden="true" />
              </summary>
              <div className="rr-check-detail">
                <dl className="tw-comparison">
                  {check.expected && (
                    <div>
                      <dt>Expected</dt>
                      <dd>{check.expected}</dd>
                    </div>
                  )}
                  <div>
                    <dt>
                      {category === "not-tested"
                        ? "Recorded reason"
                        : category === "uncertain"
                          ? "What could be established"
                          : "What happened"}
                    </dt>
                    <dd>{check.actual}</dd>
                  </div>
                </dl>
                <EvidenceButton
                  refs={check.evidence}
                  onEvidence={onEvidence}
                  context={{
                    title: check.title,
                    section: checkSection(filter) as ReportEvidenceContext["section"],
                    elementId,
                  }}
                >
                  View recordings & screenshots
                </EvidenceButton>
              </div>
            </details>
          );
        })}
      </div>
      {matching.length > pageSize && (
        <nav className="rr-pagination" aria-label="Check pages">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous tests
          </button>
          <span>
            Page {currentPage + 1} of {lastPage + 1}
          </span>
          <button
            type="button"
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            Next tests
          </button>
        </nav>
      )}
    </>
  );
}

export function ReportOverview({
  content,
  onChecks,
  onSection,
}: Pick<ReportContentDesignProps, "content"> & {
  onChecks: (filter: CheckFilter, query?: string) => void;
  onSection: (section: string) => void;
}) {
  const differences = content.checks.filter((check) => checkGroup(check.label) === "different");
  return (
    <section id="overview" className="rr-overview" aria-labelledby="rr-overview-heading">
      <p className="tw-kicker">Start here</p>
      <h2 id="rr-overview-heading">Test results</h2>
      <p className="rr-intro">
        {content.checks.length} recorded {content.checks.length === 1 ? "test" : "tests"}. Choose a
        result below to see what happened and review the evidence.
      </p>
      <div className="rr-counts">
        {filters.slice(1).map((item) => (
          <button
            type="button"
            key={item.value}
            className={`rr-count rr-count--${item.value}`}
            onClick={() => onChecks(item.value)}
          >
            <strong>
              {content.checks.filter((check) => checkGroup(check.label) === item.value).length}
            </strong>
            <span>{item.label}</span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="rr-count-explanation">
        These numbers count recorded tests, not unique issues or how much of the app was tested. A
        confirmed result covers only the comparison described, not every step or scenario.
      </p>
      <section className="rr-coverage-limits" aria-labelledby="rr-limits-heading">
        <div className="rr-attention-heading">
          <h3 id="rr-limits-heading">Testing limits</h3>
          <button className="tw-evidence-link" onClick={() => onSection("context")}>
            {content.limitations.length
              ? `Read all ${content.limitations.length} limits`
              : "Review testing scope"}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
        {content.limitations.length ? (
          <ul>
            {content.limitations.slice(0, 4).map((limit, index) => (
              <li key={index}>{reportSentences(limit)[0] ?? limit}</li>
            ))}
          </ul>
        ) : (
          <p>
            No limitations were recorded. This does not establish that every requested scenario was
            verified.
          </p>
        )}
        {content.limitations.length > 4 && (
          <p className="rr-limits-more">
            Showing the first 4 of {content.limitations.length} recorded limits.
          </p>
        )}
      </section>
      <div className="rr-attention-heading">
        <div>
          <p className="tw-kicker">Expected versus observed</p>
          <h3>What didn’t work as expected</h3>
        </div>
        {differences.length > 0 && (
          <button className="tw-evidence-link" onClick={() => onChecks("different")}>
            Review all {differences.length}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {differences.length ? (
        <ul className="rr-attention-list">
          {differences.slice(0, 4).map((check, index) => (
            <li key={`${check.title}-${index}`}>
              <button type="button" onClick={() => onChecks("different", check.title)}>
                <XCircle size={17} aria-hidden="true" />
                <span>
                  <strong>{check.title}</strong>
                  <span>{check.actual}</span>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rr-quiet">
          {content.checks.length
            ? "No tests were recorded as not working as expected. Review unconfirmed results, untested work and testing gaps before drawing a conclusion."
            : "This report has no individual test results. Review its possible issues, earlier test notes and testing coverage; do not assume everything was tested."}
        </p>
      )}
      <div className="rr-overview-footer">
        <button onClick={() => onSection("context")}>
          <span>
            <strong>Testing coverage & gaps</strong>
            <small>Understand what was and wasn’t verified</small>
          </span>
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        {content.observations.length > 0 && (
          <button onClick={() => onSection("observations")}>
            <span>
              <strong>{content.observations.length} possible issues</strong>
              <small>Not confirmed problems—review whether they match your intent</small>
            </span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}
