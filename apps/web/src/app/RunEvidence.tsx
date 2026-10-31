import { useEffect, useState } from "react";
import { api, apiBlob } from "../infrastructure/api/client.js";

type Media = {
  index: number;
  kind: "video" | "screenshot";
  timestamp: number;
  label: string;
  durationMs?: number;
  coverage?: "complete" | "partial";
};
type Publication = { warning: string; playbackRate: 1; items: Media[] };

/** Media is fetched with the same bearer/workspace authorization as the Run.
 * Blob URLs are local to this view and revoked on selection change/unmount. */
export function RunEvidence({ runId }: { runId: string }) {
  const [publication, setPublication] = useState<Publication>();
  const [selected, setSelected] = useState<Media>();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
          setSelected(data.items.find((item) => item.kind === "video") ?? data.items[0]);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Evidence could not be loaded. Reopen this view to retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refresh]);
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
          setError("This recording could not be loaded. Select it again to retry.");
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId, selected]);
  return (
    <section className="panel native-evidence" aria-label="Run recordings and screenshots">
      <h3>Recordings & screenshots</h3>
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
          <div className="native-evidence-selector" role="group" aria-label="Select evidence">
            {publication.items.map((item) => (
              <button
                key={item.index}
                aria-pressed={selected?.index === item.index}
                onClick={() => setSelected({ ...item })}
              >
                {item.kind === "video" ? "Recording" : "Screenshot"} · {item.label} ·{" "}
                {new Date(item.timestamp).toLocaleTimeString()}
                {item.coverage === "partial" ? " · Partial recording" : ""}
              </button>
            ))}
          </div>
          {source && selected ? (
            selected.kind === "video" ? (
              <>
                <video
                  key={source}
                  src={source}
                  controls
                  preload="metadata"
                  playsInline
                  aria-label="Native browser recording"
                />
                <p>
                  Original capture timing · 1× playback. Use the player controls to pause or seek.
                </p>
                {selected.coverage === "partial" && (
                  <p role="status">
                    This recording covers only part of the Run. Missing footage is an evidence gap,
                    not a defect in the tested app.
                  </p>
                )}
              </>
            ) : (
              <figure>
                <img src={source} alt={`Browser after ${selected.label}`} />
                <figcaption>Native screenshot · {selected.label}</figcaption>
              </figure>
            )
          ) : !error ? (
            <p role="status">Loading selected evidence…</p>
          ) : null}
        </>
      )}
    </section>
  );
}
