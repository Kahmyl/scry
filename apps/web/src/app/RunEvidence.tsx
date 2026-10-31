import { useEffect, useRef, useState } from "react";
import { api, apiBlob } from "../infrastructure/api/client.js";

type Media = {
  index: number;
  kind: "video" | "screenshot";
  timestamp: number;
  label: string;
  durationMs?: number;
  coverage?: "complete" | "partial";
  title?: string;
  description?: string;
  artifactId?: string;
  interruptionReason?: string;
};
type Publication = { warning: string; playbackRate: 1; items: Media[] };

/** Media is fetched with the same bearer/workspace authorization as the Run.
 * Blob URLs are local to this view and revoked on selection change/unmount. */
export function RunEvidence({
  runId,
  initialArtifactId,
}: {
  runId: string;
  initialArtifactId?: string;
}) {
  const [publication, setPublication] = useState<Publication>();
  const [selected, setSelected] = useState<Media>();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [speed, setSpeed] = useState(1);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [source, speed]);
  useEffect(() => {
    let cancelled = false;
    setPublication(undefined);
    setSelected(undefined);
    setSource("");
    setError("");
    void api<Publication>(`/runs/${runId}/media`)
      .then((data) => {
        if (!cancelled) {
          setPublication(data);
          const choice = initialArtifactId
            ? data.items.find((item) => item.artifactId === initialArtifactId)
            : (data.items.find((item) => item.kind === "video") ?? data.items[0]);
          setSelected(choice);
          if (initialArtifactId && !choice)
            setError(
              "The report’s evidence reference is not available in this attempt. Choose another item to review; it is not a substitute for the missing reference.",
            );
        }
      })
      .catch(() => {
        if (!cancelled) setError("Evidence could not be loaded. Reopen this view to retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refresh, initialArtifactId]);
  useEffect(() => {
    setSource("");
    if (!selected) return;
    const controller = new AbortController();
    let url = "";
    void apiBlob(`/runs/${runId}/media/${selected.index}`, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setSource(url);
        setError("");
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("This evidence item could not be loaded. Select it again to retry.");
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId, selected]);
  return (
    <section className="panel native-evidence" aria-label="Run recordings and screenshots">
      <h3>Recordings and screenshots</h3>
      <button onClick={() => setRefresh((value) => value + 1)}>Refresh evidence</button>
      <p className="native-evidence-warning">
        {publication?.warning ??
          "Automatic redaction is best effort. Sensitive information may remain. Review before sharing."}
      </p>
      {error && <p role="alert">{error}</p>}
      {!publication && !error ? (
        <p role="status">Loading evidence…</p>
      ) : !publication ? null : !publication.items.length ? (
        <p>
          No native media is available yet. Refresh after the Run closes. Historical recordings are
          not rewritten.
        </p>
      ) : (
        <>
          <label className="native-evidence-mobile">
            Choose evidence
            <select
              aria-label="Choose evidence"
              value={selected?.index ?? ""}
              onChange={(e) => {
                const item = publication.items.find(
                  (item) => item.index === Number(e.target.value),
                );
                setSelected(item ? { ...item } : undefined);
              }}
            >
              {!selected && <option value="">Choose an available item</option>}
              {publication.items.map((item) => (
                <option key={item.index} value={item.index}>
                  {title(item)} · {item.kind === "video" ? "Recording" : "Screenshot"}
                </option>
              ))}
            </select>
          </label>
          <div className="native-evidence-layout">
            <div className="native-evidence-selector" role="group" aria-label="Select evidence">
              {publication.items.map((item) => (
                <button
                  key={item.index}
                  aria-pressed={selected?.index === item.index}
                  onClick={() => setSelected({ ...item })}
                >
                  {title(item)}
                  <small>
                    {item.kind === "video" ? "Recording" : "Screenshot"} ·{" "}
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </small>
                  {item.coverage === "partial" ? " · Partial recording" : ""}
                </button>
              ))}
            </div>
            <div className="native-evidence-viewer" aria-live="polite">
              {selected && (
                <>
                  <h4>{title(selected)}</h4>
                  {selected.description && <p>{selected.description}</p>}
                </>
              )}
              {source && selected ? (
                selected.kind === "video" ? (
                  <>
                    <video
                      ref={video}
                      key={source}
                      src={source}
                      controls
                      preload="metadata"
                      playsInline
                      aria-label="Native browser recording"
                      onError={() =>
                        setError(
                          "This recording cannot be played. Choose another item or refresh the evidence list.",
                        )
                      }
                    />
                    <label>
                      Playback speed{" "}
                      <select
                        aria-label="Playback speed"
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                      >
                        <option value={0.25}>0.25×</option>
                        <option value={0.5}>0.5×</option>
                        <option value={1}>1× · normal</option>
                        <option value={1.5}>1.5×</option>
                        <option value={2}>2×</option>
                      </select>
                    </label>
                    <p>
                      Original capture timing. Pause, seek or slow playback to inspect each state.
                      Separate recordings represent separate attempts or capture interruptions—not
                      reconstructed continuity.
                    </p>
                    {selected.coverage === "partial" && (
                      <p role="status">
                        This recording covers only part of the Run. Missing footage is an evidence
                        gap, not a defect in the tested app.
                        {selected.interruptionReason === "recording_capacity" &&
                          " The recording reached its storage allowance."}
                        {selected.interruptionReason === "browser_interrupted" &&
                          " Browser execution was interrupted."}
                      </p>
                    )}
                  </>
                ) : (
                  <figure>
                    <img
                      src={source}
                      alt={title(selected)}
                      onError={() =>
                        setError(
                          "This screenshot cannot be displayed. Select it again or refresh the evidence list.",
                        )
                      }
                    />
                  </figure>
                )
              ) : !error ? (
                <p role="status">Loading selected evidence…</p>
              ) : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function title(item: Media): string {
  return (
    item.title ??
    (item.kind === "video"
      ? "Browser recording"
      : `Screenshot at ${new Date(item.timestamp).toLocaleTimeString()}`)
  );
}
