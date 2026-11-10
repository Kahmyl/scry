import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Film, Image, RefreshCw } from "lucide-react";
import { api, apiBlob, API_BASE, videoPlayback } from "../infrastructure/api/client.js";
import "./run-evidence.css";
import { EvidenceLoading } from "./EvidenceLoading.js";
import { MaskingReview } from "./MaskingReview.js";
import type { MaskingDiagnostic } from "@scry/contracts";

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
  maskingDiagnostics?: { events: MaskingDiagnostic[]; truncated: boolean };
};
type Publication = { warning: string; playbackRate: 1; items: Media[] };

/** Only the selected item is fetched. Authorization, exact references and native timing are unchanged. */
export function RunEvidence({
  runId,
  initialArtifactId,
}: {
  runId: string;
  initialArtifactId?: string;
}) {
  const [publication, setPublication] = useState<Publication>();
  const [selected, setSelected] = useState<Media>();
  const [kind, setKind] = useState<Media["kind"]>("video");
  const [page, setPage] = useState(0);
  const [mediaSource, setMediaSource] = useState<{ runId: string; item: Media; url: string }>();
  const source =
    mediaSource?.runId === runId && mediaSource.item === selected ? mediaSource.url : "";
  const [readyFor, setReadyFor] = useState<{ source: string; item: Media }>();
  const [bufferingFor, setBufferingFor] = useState<{ source: string; item: Media }>();
  const ready = !!source && readyFor?.source === source && readyFor.item === selected;
  const buffering = !!source && bufferingFor?.source === source && bufferingFor.item === selected;
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
    setMediaSource(undefined);
    setError("");
    setPage(0);
    void api<Publication>(`/runs/${runId}/media`)
      .then((data) => {
        if (cancelled) return;
        setPublication(data);
        const choice = initialArtifactId
          ? data.items.find((item) => item.artifactId === initialArtifactId)
          : (data.items.find((item) => item.kind === "video") ?? data.items[0]);
        setSelected(choice);
        const nextKind =
          choice?.kind ??
          (data.items.some((item) => item.kind === "video") ? "video" : "screenshot");
        setKind(nextKind);
        if (choice)
          setPage(
            Math.floor(data.items.filter((item) => item.kind === nextKind).indexOf(choice) / 8),
          );
        if (initialArtifactId && !choice)
          setError(
            "The report’s evidence reference is not available in this attempt. Choose another item to review; it is not a substitute for the missing reference.",
          );
      })
      .catch(() => {
        if (!cancelled)
          setError("Evidence could not be loaded. Refresh the evidence list to retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refresh, initialArtifactId]);
  useEffect(() => {
    setMediaSource(undefined);
    if (!selected) return;
    setError("");
    const controller = new AbortController();
    let url = "";
    if (selected.kind === "video") {
      let grantId: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const renew = async () => {
        if (!grantId || controller.signal.aborted) return;
        try {
          await videoPlayback(`/media-playback/${grantId}/renew`, {
            method: "POST",
            signal: controller.signal,
          });
          if (!controller.signal.aborted) timer = setTimeout(() => void renew(), 50000);
        } catch {
          if (!controller.signal.aborted) {
            setMediaSource(undefined);
            setError(
              "Playback authorization could not be refreshed. Select the recording again to retry.",
            );
          }
        }
      };
      void videoPlayback<{ id: string; path: string }>(
        `/runs/${runId}/media/${selected.index}/playback`,
        { method: "POST", signal: controller.signal },
      )
        .then((grant) => {
          grantId = grant.id;
          if (controller.signal.aborted) {
            void videoPlayback(`/media-playback/${grantId}`, { method: "DELETE" }).catch(() => {});
            return;
          }
          setMediaSource({ runId, item: selected, url: API_BASE + grant.path });
          setError("");
          timer = setTimeout(() => void renew(), 50000);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("This recording could not be authorized. Select it again to retry.");
        });
      return () => {
        controller.abort();
        clearTimeout(timer);
        if (grantId)
          void videoPlayback(`/media-playback/${grantId}`, { method: "DELETE" }).catch(() => {});
      };
    }
    void apiBlob(`/runs/${runId}/media/${selected.index}`, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setMediaSource({ runId, item: selected, url });
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
  const items = publication?.items.filter((item) => item.kind === kind) ?? [];
  const currentIndex = selected ? items.findIndex((item) => item.index === selected.index) : -1;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 8) - 1));
  const choose = (item: Media) => {
    setSelected({ ...item });
    setKind(item.kind);
    setPage(Math.floor(items.indexOf(item) / 8));
  };
  const kindPicker = publication?.items.length ? (
    <div className="ne-kind-picker" role="group" aria-label="Evidence type">
      {(["video", "screenshot"] as const).map((value) => {
        const count = publication.items.filter((item) => item.kind === value).length;
        const Icon = value === "video" ? Film : Image;
        return (
          <button
            key={value}
            aria-pressed={kind === value}
            disabled={!count}
            onClick={() => {
              setKind(value);
              setPage(0);
              const first = publication.items.find((item) => item.kind === value);
              if (first) setSelected({ ...first });
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {value === "video" ? "Recordings" : "Screenshots"}
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  ) : null;
  return (
    <section
      className="panel native-evidence ne-player"
      aria-label="Run recordings and screenshots"
    >
      <div className="ne-header">
        <h3 className={publication?.items.length ? "ne-sr-only" : undefined}>
          Recordings &amp; screenshots
        </h3>
        {kindPicker}
        <button onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh evidence
        </button>
      </div>
      <p className="native-evidence-warning">
        {publication?.warning ??
          "Automatic redaction is best effort. Sensitive information may remain. Review before sharing."}
      </p>
      {error && <p role="alert">{error}</p>}
      {selected?.maskingDiagnostics && (
        <MaskingReview
          diagnostics={selected.maskingDiagnostics}
          onSeek={
            selected.kind === "video"
              ? (timestamp) => {
                  if (video.current)
                    video.current.currentTime = Math.max(
                      0,
                      (timestamp - selected.timestamp) / 1000 - 1,
                    );
                }
              : undefined
          }
        />
      )}
      {!publication && !error ? (
        <EvidenceLoading
          layout="library"
          label="Loading recordings & screenshots…"
          detail="Fetching the available evidence for this attempt."
        />
      ) : !publication ? null : !publication.items.length ? (
        <p>
          No recordings or screenshots are available for this attempt yet. Refresh to check again.
          Missing evidence does not establish an application result.
        </p>
      ) : (
        <>
          <div
            className="native-evidence-viewer ne-viewer"
            aria-live="polite"
            aria-busy={!!selected && (!ready || buffering) && !error}
          >
            {selected && (
              <header className="ne-item-heading">
                <p>
                  {selected.kind === "video" ? "Recording" : "Screenshot"} {currentIndex + 1} of{" "}
                  {items.length}
                  {selected.durationMs !== undefined && selected.kind === "video"
                    ? ` · ${duration(selected.durationMs)}`
                    : ""}
                </p>
                <h4>{title(selected)}</h4>
                {selected.description && <p>{selected.description}</p>}
              </header>
            )}
            {source && selected ? (
              selected.kind === "video" ? (
                <>
                  <div
                    className={`ne-media-frame${!error && (!ready || buffering) ? " is-loading" : ""}`}
                  >
                    <video
                      crossOrigin="use-credentials"
                      ref={video}
                      key={source}
                      src={source}
                      controls
                      preload="metadata"
                      playsInline
                      aria-label="Browser recording"
                      onLoadedData={() => {
                        setReadyFor({ source, item: selected });
                        setBufferingFor(undefined);
                      }}
                      onCanPlay={() => {
                        setReadyFor({ source, item: selected });
                        setBufferingFor(undefined);
                      }}
                      onPlaying={() => setBufferingFor(undefined)}
                      onWaiting={() => setBufferingFor({ source, item: selected })}
                      onSeeking={() => setBufferingFor({ source, item: selected })}
                      onSeeked={() => setBufferingFor(undefined)}
                      onError={() =>
                        setError(
                          "This recording cannot be played. Choose another item or refresh the evidence list.",
                        )
                      }
                    />
                    {!error && (!ready || buffering) && (
                      <EvidenceLoading
                        label={ready ? "Buffering recording…" : "Preparing recording…"}
                        detail={
                          ready
                            ? "Waiting for the next frames."
                            : "The recording is opening in your browser."
                        }
                      />
                    )}
                  </div>
                  <div className="ne-playback">
                    <label>
                      Playback speed{" "}
                      <select
                        aria-label="Playback speed"
                        value={speed}
                        onChange={(event) => setSpeed(Number(event.target.value))}
                      >
                        <option value={0.25}>0.25×</option>
                        <option value={0.5}>0.5×</option>
                        <option value={1}>1× · normal</option>
                        <option value={1.5}>1.5×</option>
                        <option value={2}>2×</option>
                      </select>
                    </label>
                    <span>Recorded at the original pace. Pause or seek to inspect a moment.</span>
                  </div>
                  {selected.coverage === "partial" && (
                    <p role="status">
                      This recording covers only part of the attempt. Missing footage is an evidence
                      gap, not a defect in the tested app.
                    </p>
                  )}
                </>
              ) : (
                <figure>
                  <div className={`ne-media-frame${!ready && !error ? " is-loading" : ""}`}>
                    <img
                      src={source}
                      alt={title(selected)}
                      onLoad={() => setReadyFor({ source, item: selected })}
                      onError={() =>
                        setError(
                          "This screenshot cannot be displayed. Select it again or refresh the evidence list.",
                        )
                      }
                    />
                    {!ready && !error && (
                      <EvidenceLoading
                        label="Preparing screenshot…"
                        detail="The image is opening in your browser."
                      />
                    )}
                  </div>
                  <figcaption>
                    <a href={source} target="_blank" rel="noopener noreferrer">
                      Open full-size screenshot
                    </a>
                  </figcaption>
                </figure>
              )
            ) : !error ? (
              <EvidenceLoading
                label={
                  selected?.kind === "screenshot" ? "Loading screenshot…" : "Loading recording…"
                }
                detail={
                  selected?.kind === "video"
                    ? "Larger recordings may take a little longer."
                    : "Fetching the selected image."
                }
              />
            ) : null}
          </div>
          {selected && items.length > 1 && (
            <div className="ne-item-navigation">
              <button
                disabled={currentIndex <= 0}
                onClick={() => {
                  const item = items[currentIndex - 1];
                  if (item) choose(item);
                }}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Previous {kind === "video" ? "recording" : "screenshot"}
              </button>
              <button
                disabled={currentIndex < 0 || currentIndex >= items.length - 1}
                onClick={() => {
                  const item = items[currentIndex + 1];
                  if (item) choose(item);
                }}
              >
                Next {kind === "video" ? "recording" : "screenshot"}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {items.length > 1 || !selected ? (
            <div className="ne-item-browser">
              <h4>{kind === "video" ? "Choose a recording" : "Choose a screenshot"}</h4>
              <div className="ne-items" role="group" aria-label="Select evidence">
                {items.slice(currentPage * 8, currentPage * 8 + 8).map((item, index) => (
                  <button
                    key={item.index}
                    aria-pressed={selected?.index === item.index}
                    onClick={() => choose(item)}
                  >
                    <span className="ne-item-number">{currentPage * 8 + index + 1}</span>
                    <span>
                      <strong>{title(item)}</strong>
                      <small>
                        {item.kind === "video" ? "Recording" : "Screenshot"}
                        {item.durationMs !== undefined && item.kind === "video"
                          ? ` · ${duration(item.durationMs)}`
                          : ""}{" "}
                        · {new Date(item.timestamp).toLocaleTimeString()}
                        {item.coverage === "partial" ? " · Partial recording" : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {items.length > 8 && (
                <nav className="rr-pagination" aria-label="Evidence pages">
                  <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                    Previous items
                  </button>
                  <span>
                    Page {currentPage + 1} of {Math.ceil(items.length / 8)}
                  </span>
                  <button
                    disabled={(currentPage + 1) * 8 >= items.length}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next items
                  </button>
                </nav>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function title(item: Media): string {
  return (
    item.title?.trim() ||
    (item.kind === "video"
      ? "Browser recording"
      : `Screenshot at ${new Date(item.timestamp).toLocaleTimeString()}`)
  );
}
