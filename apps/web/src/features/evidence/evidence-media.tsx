import {
  AlertTriangle,
  Box,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Image,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiBlob, type Report } from "../../infrastructure/api/client.js";
import { formatBytes, formatDuration } from "../../shared/format/dashboard-format.js";
import type { RecordingTimelineEntry } from "../runs/recording-timeline.js";

export function AuthenticatedArtifact({
  artifact,
  image = false,
}: {
  artifact: Report["artifacts"][number];
  image?: boolean;
}) {
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (artifact.availability !== "available") return;
    setUrl(undefined);
    setLoadError("");
    let disposed = false;
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifact.id}`)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((cause) => {
        if (!disposed) setLoadError(artifactLoadMessage(cause));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.availability, artifact.id, retryKey]);

  if (artifact.availability === "quarantined" || artifact.availability === "destroyed") {
    return (
      <div className="artifact-quarantined">
        <ShieldCheck size={16} />
        <span>
          <strong>{artifact.kind} quarantined</strong>
          <small>
            Uncertain bytes were destroyed ·{" "}
            {String(artifact.observation?.reasonCode ?? "PRIVACY_UNCERTAIN")}
          </small>
        </span>
      </div>
    );
  }

  if (image) {
    if (loadError) {
      return (
        <ArtifactLoadFailure
          kind="screenshot"
          error={loadError}
          onRetry={() => setRetryKey((key) => key + 1)}
        />
      );
    }
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-disabled={!url}>
        {url ? (
          <img src={url} alt={`Screenshot from step ${artifact.stepId ?? ""}`} />
        ) : (
          <div className="artifact-loading">
            <LoaderCircle className="spin" size={18} />
          </div>
        )}
        <span>
          <Image size={14} /> {artifact.stepId ?? "Run screenshot"} <ExternalLink size={13} />
        </span>
      </a>
    );
  }
  if (loadError) {
    return (
      <ArtifactLoadFailure
        kind={artifact.kind}
        error={loadError}
        onRetry={() => setRetryKey((key) => key + 1)}
      />
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-disabled={!url}>
      {artifact.kind === "trace" ? (
        <Box size={16} />
      ) : artifact.kind === "network" ? (
        <Network size={16} />
      ) : (
        <FileText size={16} />
      )}
      <span>
        <strong>{artifact.kind}</strong>
        <small>{formatBytes(Number(artifact.sizeBytes ?? 0))}</small>
      </span>
      {url ? <ExternalLink size={13} /> : <LoaderCircle className="spin" size={13} />}
    </a>
  );
}

export function AuthenticatedVideo({ artifact }: { artifact: Report["artifacts"][number] }) {
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setUrl(undefined);
    setLoadError("");
    let disposed = false;
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifact.id}`)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((cause) => {
        if (!disposed) setLoadError(artifactLoadMessage(cause));
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, retryKey]);

  return (
    <div className="run-recording">
      <div className="run-recording-head">
        <div>
          <Play size={15} />
          <span>
            <strong>Run recording</strong>
            <small>Watch the complete browser journey</small>
          </span>
        </div>
        <span>{formatBytes(Number(artifact.sizeBytes ?? 0))}</span>
      </div>
      {loadError ? (
        <ArtifactLoadFailure
          kind="recording"
          error={loadError}
          onRetry={() => setRetryKey((key) => key + 1)}
        />
      ) : url ? (
        <EvidenceVideo src={url} label="Play run recording" />
      ) : (
        <div className="recording-loading">
          <LoaderCircle className="spin" size={20} /> Preparing recording…
        </div>
      )}
    </div>
  );
}

function ArtifactLoadFailure({
  kind,
  error,
  onRetry,
}: {
  kind: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="artifact-load-failure" role="alert">
      <AlertTriangle size={20} />
      <span>
        <strong>{kind} unavailable</strong>
        <small>{error}</small>
      </span>
      <button type="button" onClick={onRetry}>
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}

function artifactLoadMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\(401\)|\(403\)/.test(detail)) return "Access to this evidence could not be verified.";
  if (/\(404\)|\(410\)/.test(detail)) return "This evidence is no longer available.";
  return "Evidence retrieval failed. Retry the request or review Advanced diagnostics.";
}

function EvidenceVideo({ src, label }: { src: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setPlaying(false), [src]);

  const play = () => {
    const result = videoRef.current?.play();
    if (result) void result.catch(() => setPlaying(false));
  };

  return (
    <div className="recording-video-stage">
      <video
        ref={videoRef}
        controls
        preload="metadata"
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      >
        Your browser does not support WebM video.
      </video>
      {!playing && (
        <button className="recording-play-overlay" type="button" aria-label={label} onClick={play}>
          <Play size={30} fill="currentColor" />
        </button>
      )}
    </div>
  );
}

export function RecordingPlaylist({
  entries,
  artifacts,
}: {
  entries: RecordingTimelineEntry[];
  artifacts: Report["artifacts"];
}) {
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const entry = entries[index];
  const artifact =
    entry?.type === "video_segment" && entry.artifactId
      ? artifacts.find((candidate) => candidate.id === entry.artifactId)
      : undefined;
  const entryId = entry?.id;
  const entryType = entry?.type;
  const entryStatus = entry?.type === "video_segment" ? entry.status : undefined;
  const artifactId = artifact?.id;

  const advance = useCallback(
    () => setIndex((current) => Math.min(current + 1, entries.length - 1)),
    [entries.length],
  );

  useEffect(() => {
    setUrl(undefined);
    setLoadFailed(false);
    if (entryType !== "video_segment" || entryStatus !== "available" || !artifactId) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void apiBlob(`/artifacts/${artifactId}`)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setLoadFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, entryId, entryStatus, entryType]);

  if (!entry) return null;
  const durationMs =
    "endedAt" in entry && "startedAt" in entry
      ? Math.max(0, new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime())
      : 0;
  return (
    <div className="run-recording">
      <div className="run-recording-head">
        <div>
          <Play size={15} />
          <span>
            <strong>Run recording</strong>
            <small>
              Segment {index + 1} of {entries.length}
            </small>
          </span>
        </div>
        <div className="recording-segment-nav">
          <button
            type="button"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={index === 0}
          >
            <ChevronLeft size={16} /> Previous
          </button>
          <span>{formatDuration(durationMs)}</span>
          <button type="button" onClick={advance} disabled={index === entries.length - 1}>
            Next <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {entry.type === "video_segment" && entry.status === "available" && url && !loadFailed && (
        <EvidenceVideo src={url} label={`Play recording segment ${index + 1}`} />
      )}
      {entry.type === "video_segment" && entry.status === "available" && !url && !loadFailed && (
        <div className="recording-loading">
          <LoaderCircle className="spin" size={20} /> Preparing segment…
        </div>
      )}
      {entry.type === "protected_gap" && (
        <div className="recording-gap">
          <ShieldCheck size={24} />
          <strong>Protected operation</strong>
          <span>Visual capture was suspended for this interval.</span>
        </div>
      )}
      {(entry.type === "unavailable_interval" ||
        (entry.type === "video_segment" && (entry.status !== "available" || loadFailed))) && (
        <div className="recording-gap recording-unavailable">
          <AlertTriangle size={24} />
          <strong>Recording interval unavailable</strong>
          <span>
            {entry.type === "unavailable_interval"
              ? entry.failureCode
              : (entry.failureCode ?? "SEGMENT_UNAVAILABLE")}
          </span>
        </div>
      )}
      <div className="recording-playlist-controls">
        <span>
          {entries.map((item, itemIndex) => (
            <i className={itemIndex === index ? "active" : ""} key={item.id} />
          ))}
        </span>
      </div>
    </div>
  );
}
