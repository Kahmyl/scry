import type { MaskingDiagnostic } from "@scry/contracts";
const reasonLabels = new Map<string, string>([
  ["installation_pending", "Masking was still being installed"],
  ["installation_failed", "Masking could not be installed"],
  ["maintenance_timeout", "A masking refresh did not finish in time"],
  ["maintenance_failed", "A masking refresh could not be confirmed"],
  ["dialog_refresh_deferred", "Masking refresh paused while a dialog was open"],
  ["refresh_confirmed", "Masking refresh was confirmed"],
  ["page_closed", "The page closed"],
]);
function intervalTime(at: number, recordingStart?: number) {
  if (recordingStart === undefined || !Number.isFinite(recordingStart))
    return new Date(at).toLocaleTimeString();
  const seconds = Math.max(0, Math.floor((at - recordingStart) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function maskingIntervals(events: MaskingDiagnostic[]) {
  const open = new Map<string, { pageId: string; start: number; reason: string }>(),
    intervals: Array<{
      pageId: string;
      start: number;
      reason: string;
      end?: number;
      resolution: string;
    }> = [];
  for (const e of events) {
    const prior = open.get(e.pageId);
    if (prior) {
      intervals.push({
        ...prior,
        end: e.at,
        resolution:
          e.state === "degraded"
            ? "reason changed"
            : e.state === "recovered"
              ? "refresh confirmed"
              : "page closed",
      });
      open.delete(e.pageId);
    }
    if (e.state === "degraded")
      open.set(e.pageId, { pageId: e.pageId, start: e.at, reason: e.reason });
  }
  for (const pending of open.values())
    intervals.push({ ...pending, resolution: "recovery not confirmed" });
  return intervals.sort((a, b) => a.start - b.start);
}
export function MaskingReview({
  diagnostics,
  onSeek,
  recordingStart,
  canSeek = true,
}: {
  diagnostics: { events: MaskingDiagnostic[]; truncated: boolean };
  onSeek?: ((timestamp: number) => void) | undefined;
  recordingStart?: number | undefined;
  canSeek?: boolean | undefined;
}) {
  const intervals = maskingIntervals(diagnostics.events);
  return (
    <details>
      <summary>Masking review intervals</summary>
      {intervals.length ? (
        <p>
          Automatic masking could not be confirmed during these parts of the evidence. Review these
          parts before sharing.
        </p>
      ) : (
        <p>
          No specific masking review intervals were recorded. Review the evidence before sharing.
        </p>
      )}
      <p>
        An interval does not establish that information was disclosed. A confirmed recovery or an
        empty history does not certify the rest of the recording or remove an earlier limitation.
      </p>
      {onSeek && !canSeek && (
        <p>Interval review buttons are available when the recording has loaded.</p>
      )}
      <ol>
        {intervals.map((i, n) => (
          <li key={n}>
            {intervalTime(i.start, recordingStart)}–
            {i.end ? intervalTime(i.end, recordingStart) : "end not confirmed"} ·{" "}
            {reasonLabels.get(i.reason) ?? "Masking status could not be confirmed"} · {i.resolution}
            {onSeek && (
              <button disabled={!canSeek} onClick={() => onSeek(i.start)}>
                Review this interval
              </button>
            )}
            <details>
              <summary>Interval details</summary>
              Page {i.pageId.slice(0, 8)} · {new Date(i.start).toISOString()}
            </details>
          </li>
        ))}
      </ol>
      {diagnostics.truncated && (
        <p>Additional intervals were not retained. Review the recording before sharing.</p>
      )}
    </details>
  );
}
