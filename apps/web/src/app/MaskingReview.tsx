import type { MaskingDiagnostic } from "@scry/contracts";
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
}: {
  diagnostics: { events: MaskingDiagnostic[]; truncated: boolean };
  onSeek?: ((timestamp: number) => void) | undefined;
}) {
  return (
    <details>
      <summary>Masking review intervals</summary>
      <p>
        These intervals describe unconfirmed maintenance or installation, not proof of disclosed
        information. Recovery does not remove earlier limitations.
      </p>
      <ol>
        {maskingIntervals(diagnostics.events).map((i, n) => (
          <li key={n}>
            {new Date(i.start).toISOString()} —{" "}
            {i.end ? new Date(i.end).toISOString() : "end not confirmed"} · Page{" "}
            {i.pageId.slice(0, 8)} · {i.reason.replaceAll("_", " ")} · {i.resolution}
            {onSeek && <button onClick={() => onSeek(i.start)}>Review this interval</button>}
          </li>
        ))}
      </ol>
      {diagnostics.truncated && (
        <p>Additional intervals were not retained. Review the recording before sharing.</p>
      )}
    </details>
  );
}
