import { useState } from "react";
import { ArrowLeft, ArrowRight, Film, Search } from "lucide-react";
import type { JourneyEvidenceDesignProps } from "./testing-design-types.js";

/** Report readers choose a named activity before an attempt; exact finding links bypass the library. */
export function ReportEvidenceBrowser({
  journeys,
  selectedRunId,
  selectionRequest,
  onSelect,
  findingContext,
  evidence,
}: JourneyEvidenceDesignProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [view, setView] = useState<{
    runId: string | undefined;
    request: typeof selectionRequest;
    emptyId?: string;
  }>();
  const localView =
    view?.runId === selectedRunId && view?.request === selectionRequest ? view : undefined;
  const browsing = localView ? !localView.emptyId : !selectedRunId;
  const emptyId = localView?.emptyId;
  const selectedJourney = journeys.find((journey) =>
    journey.attempts.some((attempt) => attempt.id === selectedRunId),
  );
  const current = emptyId ? journeys.find((journey) => journey.id === emptyId) : selectedJourney;
  const attemptIndex = current?.attempts.findIndex((attempt) => attempt.id === selectedRunId) ?? -1;
  const matching = journeys.filter((journey) =>
    `${journey.name} ${journey.purpose}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / 6) - 1));
  return (
    <section className="re-library" data-evidence-stage aria-label="Selected journey evidence">
      {findingContext}
      {browsing ? (
        <>
          <div className="re-library-heading">
            <div>
              <h3>Browse by test activity</h3>
              <p>
                Find the part of testing you want to review. Each activity keeps its attempts
                together.
              </p>
            </div>
            <span>
              {journeys.length} {journeys.length === 1 ? "activity" : "activities"}
            </span>
          </div>
          {journeys.length > 4 && (
            <label className="rr-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="Find a test activity"
                placeholder="Find an activity…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          )}
          <ul className="re-activities">
            {matching.slice(currentPage * 6, currentPage * 6 + 6).map((journey) => (
              <li key={journey.id}>
                <button
                  onClick={() => {
                    const first = journey.attempts[0];
                    if (first) {
                      onSelect(first.id);
                    } else
                      setView({
                        runId: selectedRunId,
                        request: selectionRequest,
                        emptyId: journey.id,
                      });
                  }}
                >
                  <Film size={19} aria-hidden="true" />
                  <span>
                    <small>Activity {journeys.indexOf(journey) + 1}</small>
                    <strong>{journey.name}</strong>
                    {journey.purpose && <span>{journey.purpose}</span>}
                    <small>
                      {journey.attempts.length
                        ? `${journey.attempts.length} ${journey.attempts.length === 1 ? "attempt" : "attempts"} to review`
                        : "No attempts recorded"}
                    </small>
                  </span>
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {matching.length > 6 && (
            <nav className="rr-pagination" aria-label="Activity pages">
              <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                Previous activities
              </button>
              <span>
                Page {currentPage + 1} of {Math.ceil(matching.length / 6)}
              </span>
              <button
                disabled={(currentPage + 1) * 6 >= matching.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next activities
              </button>
            </nav>
          )}
          {!journeys.length ? (
            <p className="rr-quiet">No test activities have been recorded yet.</p>
          ) : (
            !matching.length && <p role="status">No activities match your search.</p>
          )}
        </>
      ) : (
        <>
          <header className="re-current-activity">
            <p className="tw-kicker">
              Activity {current ? journeys.indexOf(current) + 1 : "unavailable"}
            </p>
            <button
              className="tw-evidence-link re-back"
              onClick={() => setView({ runId: selectedRunId, request: selectionRequest })}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              All test activities
            </button>
            <h3>{current?.name ?? "This evidence reference is unavailable"}</h3>
            {current?.purpose && (
              <details className="re-activity-purpose">
                <summary>About this activity</summary>
                <p>{current.purpose}</p>
              </details>
            )}
          </header>
          {current && current.attempts.length > 1 && (
            <div className="re-attempt-picker" role="group" aria-label="Choose a test attempt">
              <p>Choose an attempt</p>
              {current.attempts.map((attempt, index) => (
                <button
                  key={attempt.id}
                  aria-pressed={attempt.id === selectedRunId}
                  onClick={() => onSelect(attempt.id)}
                >
                  Attempt {index + 1}
                </button>
              ))}
            </div>
          )}
          {attemptIndex >= 0 && current!.attempts.length === 1 && (
            <p className="re-viewing-attempt">
              Attempt {attemptIndex + 1} of {current!.attempts.length} · Recordings and screenshots
              below
            </p>
          )}
          {!current ? (
            <p role="alert">
              The linked attempt is not available in this mission. Choose another activity to
              browse; it will not replace the missing evidence.
            </p>
          ) : !current.attempts.length ? (
            <p className="rr-quiet">
              No attempt was recorded for this activity, so there is no recording or screenshot to
              show.
            </p>
          ) : (
            evidence
          )}
        </>
      )}
    </section>
  );
}
