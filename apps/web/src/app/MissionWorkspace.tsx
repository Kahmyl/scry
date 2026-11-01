import { useEffect, useId, useMemo, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, FileText, ListTree, Search } from "lucide-react";
import type {
  JourneyEvidenceDesignProps,
  MissionDetailDesignProps,
} from "./testing-design-types.js";
import "./mission-workspace.css";

const MISSION_STATUS: Record<string, string> = {
  ended: "Testing work ended",
  planning: "Testing planned",
  planned: "Testing planned",
  pending: "Testing pending",
  running: "Testing in progress",
  in_progress: "Testing in progress",
  completed: "Testing completed",
  complete: "Testing completed",
  aborted: "Testing aborted · work ended",
  cancelled: "Testing cancelled · work ended",
  canceled: "Testing cancelled · work ended",
  failed: "Testing work ended",
  awaiting_user: "Needs your input",
  blocked: "Testing on hold",
};

function missionStatus(state: string): string {
  const key = state.trim().toLowerCase();
  return Object.hasOwn(MISSION_STATUS, key) ? MISSION_STATUS[key]! : "Status unavailable";
}

function attemptProgress(value: string) {
  const names: Record<string, string> = {
    ended: "Ended",
    planning: "Not started",
    pending: "Not started",
    running: "In progress",
    awaiting_user: "Needs input",
    blocked: "On hold",
    completed: "Ended",
    passed: "Ended",
    failed: "Ended",
    cancelled: "Cancelled",
    skipped: "Skipped",
  };
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
  return Object.hasOwn(names, value) ? names[value]! : "Status unavailable";
}

/** Mission context and request. The journey/evidence workspace remains owned by its child. */
export function MissionDetailDesign({
  mission,
  onBack,
  onReport,
  journeys,
}: MissionDetailDesignProps) {
  return (
    <div className="tw-page mw-mission">
      <header className="mw-mission-bar">
        <div className="mw-mission-heading">
          <div className="mw-mission-meta">
            <button type="button" className="mw-back" onClick={onBack}>
              <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
              <span>All missions</span>
            </button>
            <span className="mw-meta-divider" aria-hidden="true" />
            <span className="mw-eyebrow">Mission</span>
            <span className="mw-status">{missionStatus(mission.state)}</span>
          </div>
          <h1>{mission.title}</h1>
        </div>
        <div className="mw-mission-actions">
          <span className="mw-current-view" aria-current="page">
            Work &amp; evidence
          </span>
          {onReport && (
            <button type="button" className="mw-report" onClick={onReport}>
              <FileText aria-hidden="true" size={15} strokeWidth={1.8} />
              Read test report
            </button>
          )}
        </div>
      </header>

      <details className="mw-request">
        <summary>
          <ChevronRight className="mw-request-chevron" aria-hidden="true" size={15} />
          <span>Request &amp; objectives</span>
          <span className="mw-objective-count">
            {mission.objectives.length}{" "}
            {mission.objectives.length === 1 ? "objective" : "objectives"}
          </span>
        </summary>
        <div className="mw-request-body">
          <section className="mw-request-copy" aria-labelledby="mw-request-label">
            <h2 id="mw-request-label" className="mw-eyebrow">
              What was requested
            </h2>
            <p>{mission.instruction}</p>
          </section>
          <section className="mw-objectives" aria-labelledby="mw-objectives-label">
            <h2 id="mw-objectives-label" className="mw-eyebrow">
              Objectives
            </h2>
            {mission.objectives.length > 0 ? (
              <ol>
                {mission.objectives.map((objective, index) => (
                  <li key={objective.id}>
                    <span className="mw-objective-number" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3>{objective.title}</h3>
                      <small className="mw-objective-state">
                        {attemptProgress(objective.state)}
                      </small>
                      <p>{objective.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mw-empty-copy">No objectives have been defined yet.</p>
            )}
          </section>
        </div>
      </details>

      {journeys}
    </div>
  );
}

function attemptLabel(index: number): string {
  return `Attempt ${index + 1}`;
}

/** A single responsive journey index plus the exact evidence node supplied by the parent. */
export function JourneyEvidenceDesign({
  journeys,
  selectedRunId,
  selectionRequest,
  onSelect,
  evidence,
}: JourneyEvidenceDesignProps) {
  const selectedAttempt = useMemo(() => {
    if (!selectedRunId) return undefined;
    for (const journey of journeys) {
      const attemptIndex = journey.attempts.findIndex((attempt) => attempt.id === selectedRunId);
      if (attemptIndex !== -1) return { journey, attemptIndex };
    }
    return undefined;
  }, [journeys, selectedRunId]);

  const [emptyChoice, setEmptyChoice] = useState<{
    journeyId: string;
    atRunId: string | undefined;
    atRequest: JourneyEvidenceDesignProps["selectionRequest"];
  }>();
  const [openJourneys, setOpenJourneys] = useState<Set<string>>(
    () => new Set(selectedAttempt ? [selectedAttempt.journey.id] : []),
  );
  const [indexOpen, setIndexOpen] = useState(false);
  const [query, setQuery] = useState("");
  const indexId = useId();
  const selectedJourneyId = selectedAttempt?.journey.id;

  // An explicit evidence selection is authoritative. Polling updates that do not
  // change selectedRunId leave disclosure and zero-attempt journey choices alone.
  useEffect(() => {
    if (!selectedJourneyId) return;
    setOpenJourneys((current) => new Set(current).add(selectedJourneyId));
  }, [selectedRunId, selectedJourneyId, selectionRequest]);

  const emptyJourney =
    emptyChoice?.atRunId === selectedRunId &&
    emptyChoice?.atRequest === selectionRequest &&
    (!selectedRunId || selectedAttempt)
      ? journeys.find(
          (journey) => journey.id === emptyChoice?.journeyId && journey.attempts.length === 0,
        )
      : undefined;
  const currentJourney =
    emptyJourney ?? selectedAttempt?.journey ?? (!selectedRunId ? journeys[0] : undefined);
  const currentIndex = currentJourney ? journeys.indexOf(currentJourney) : -1;
  const currentAttemptIndex =
    selectedAttempt && selectedAttempt.journey.id === currentJourney?.id
      ? selectedAttempt.attemptIndex
      : -1;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredJourneys = normalizedQuery
    ? journeys.filter((journey) =>
        `${journey.name} ${journey.purpose}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : journeys;

  const toggleJourney = (id: string) => {
    setOpenJourneys((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chooseJourney = (journey: JourneyEvidenceDesignProps["journeys"][number]) => {
    const lastAttempt = journey.attempts[journey.attempts.length - 1];
    if (lastAttempt) {
      setEmptyChoice(undefined);
      onSelect(lastAttempt.id);
      setOpenJourneys((current) => new Set(current).add(journey.id));
      setIndexOpen(false);
    } else {
      setEmptyChoice({
        journeyId: journey.id,
        atRunId: selectedRunId,
        atRequest: selectionRequest,
      });
      setIndexOpen(false);
    }
  };

  const selectAttempt = (journeyId: string, runId: string) => {
    setEmptyChoice(undefined);
    setOpenJourneys((current) => new Set(current).add(journeyId));
    onSelect(runId);
    setIndexOpen(false);
  };

  return (
    <div className="mw-workspace">
      <div className="mw-mobile-index">
        <button
          type="button"
          className="mw-index-disclosure"
          aria-expanded={indexOpen}
          aria-controls={indexId}
          onClick={() => setIndexOpen((open) => !open)}
        >
          <ListTree aria-hidden="true" size={17} strokeWidth={1.7} />
          <span>
            <span className="mw-eyebrow">Viewing</span>
            <strong>
              {currentJourney?.name ?? "No journey selected"}
              {currentAttemptIndex >= 0 && ` · ${attemptLabel(currentAttemptIndex)}`}
            </strong>
          </span>
          <ChevronDown
            className={indexOpen ? "mw-rotated" : undefined}
            aria-hidden="true"
            size={16}
          />
        </button>
      </div>

      <aside className={`mw-index ${indexOpen ? "mw-index-open" : ""}`} id={indexId}>
        <nav aria-label="Journeys and attempts">
          <div className="mw-index-heading">
            <h2 className="mw-eyebrow">Journey index</h2>
            <span>{journeys.length}</span>
          </div>
          {journeys.length > 6 && (
            <label className="mw-filter">
              <Search aria-hidden="true" size={14} strokeWidth={1.8} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter journeys"
                aria-label="Filter journeys"
              />
            </label>
          )}
          {journeys.length > 0 ? (
            <ol className="mw-journeys">
              {filteredJourneys.map((journey) => {
                const index = journeys.indexOf(journey);
                const isCurrent = currentJourney?.id === journey.id;
                const expanded = openJourneys.has(journey.id);
                return (
                  <li key={journey.id} className={isCurrent ? "mw-journey-current" : undefined}>
                    <div className="mw-journey-row">
                      <button
                        type="button"
                        className="mw-journey"
                        aria-current={isCurrent ? "location" : undefined}
                        onClick={() => chooseJourney(journey)}
                      >
                        <span className="mw-journey-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="mw-journey-copy">
                          <span>{journey.name}</span>
                          <small>
                            {journey.attempts.length === 0
                              ? "No attempts yet"
                              : `${journey.attempts.length} ${journey.attempts.length === 1 ? "attempt" : "attempts"}`}
                          </small>
                        </span>
                      </button>
                      {journey.attempts.length > 0 && (
                        <button
                          type="button"
                          className="mw-attempt-toggle"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Hide" : "Show"} attempts for ${journey.name}`}
                          onClick={() => toggleJourney(journey.id)}
                        >
                          <ChevronRight
                            className={expanded ? "mw-rotated" : undefined}
                            aria-hidden="true"
                            size={14}
                          />
                        </button>
                      )}
                    </div>
                    {expanded && journey.attempts.length > 0 && (
                      <ol className="mw-attempts">
                        {journey.attempts.map((attempt, attemptIndex) => {
                          const selected = isCurrent && selectedRunId === attempt.id;
                          return (
                            <li key={attempt.id}>
                              <button
                                type="button"
                                className={
                                  selected ? "mw-attempt mw-attempt-selected" : "mw-attempt"
                                }
                                aria-current={selected ? "location" : undefined}
                                aria-pressed={selected}
                                aria-label={`${attemptLabel(attemptIndex)} · ${attemptProgress(attempt.progress)}`}
                                onClick={() => selectAttempt(journey.id, attempt.id)}
                              >
                                <span>{attemptLabel(attemptIndex)}</span>
                                <small>{attemptProgress(attempt.progress)}</small>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </li>
                );
              })}
              {filteredJourneys.length === 0 && (
                <li className="mw-filter-empty">No journeys match “{query.trim()}”.</li>
              )}
            </ol>
          ) : (
            <p className="mw-index-empty">Journeys will appear here when testing begins.</p>
          )}
        </nav>
      </aside>

      <section
        className="mw-evidence-column"
        data-evidence-stage
        aria-label="Selected journey evidence"
        tabIndex={-1}
      >
        <header className="mw-evidence-heading">
          <div>
            <p className="mw-eyebrow">
              {currentIndex >= 0
                ? `Journey ${String(currentIndex + 1).padStart(2, "0")}`
                : "Selected evidence"}
            </p>
            <h2>
              {currentJourney?.name ??
                (selectedRunId ? "Evidence reference unavailable" : "Work will appear here")}
              {currentAttemptIndex >= 0 && (
                <span>
                  {" "}
                  / {attemptLabel(currentAttemptIndex)} of {currentJourney?.attempts.length}
                </span>
              )}
            </h2>
            {currentJourney?.purpose && <p>{currentJourney.purpose}</p>}
          </div>
        </header>
        <section className="mw-evidence-stage">
          {emptyJourney || (!selectedRunId && !currentJourney?.attempts.length) ? (
            <div className="mw-empty-stage">
              <h3>{emptyJourney ? "No attempts yet" : "Ready for testing"}</h3>
              <p>
                {emptyJourney
                  ? "Recordings and screenshots will appear here when this journey is attempted."
                  : "Once testing begins, select a journey to review its work and evidence."}
              </p>
            </div>
          ) : (
            evidence
          )}
        </section>
      </section>
    </div>
  );
}
