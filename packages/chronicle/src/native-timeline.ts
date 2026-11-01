import path from "node:path";

export interface NativeFrameTime {
  streamId: string;
  frameId: string;
  /** Immutable receipt/transport order; not necessarily presentation order. */
  sequence: number;
  /** Native capture time, expressed as integer microseconds. */
  capturedAtMicros: number;
}

export interface NativeTimelineInput {
  streamId: string;
  frames: readonly NativeFrameTime[];
  /** Capture termination time, not the time encoding eventually finishes. */
  endedAtMicros: number;
  maximumFrames?: number;
}

export interface NativeTimelineFrame extends NativeFrameTime {
  presentationOrdinal: number;
  presentationTimeMs: number;
  durationMs: number;
}

export interface NativeTimeline {
  readonly streamId: string;
  readonly originAtMicros: number;
  readonly endedAtMicros: number;
  readonly durationMs: number;
  readonly maximumTimingErrorMicros: number;
  readonly frames: readonly Readonly<NativeTimelineFrame>[];
  /** Explicit final hold marker required by the concat demuxer. Not a new capture. */
  readonly terminalRepeat: Readonly<{ frameId: string; presentationTimeMs: number }>;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const tickMicros = 1000;
const defaultMaximumFrames = 100000;
const maximumTimingErrorMicros = tickMicros;
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Plans presentation only. Frames must already be admitted protected receipts;
 * a valid timeline is neither evidence admission nor an authorization decision.
 * Absolute positions avoid accumulating drift after a sub-millisecond interval.
 */
export function planNativeTimeline(input: NativeTimelineInput): NativeTimeline {
  const maximum = input.maximumFrames ?? defaultMaximumFrames;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum <= 0 ||
    maximum > 1000000 ||
    input.frames.length > maximum
  )
    throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_CAPACITY");
  if (!uuid.test(input.streamId) || !input.frames.length || !validTime(input.endedAtMicros))
    throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_INVALID");
  const seen = new Set<string>(),
    points: number[] = [];
  let maximumError = 0;
  for (const [index, frame] of input.frames.entries()) {
    if (frame.streamId !== input.streamId)
      throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_SCOPE_MISMATCH");
    if (!uuid.test(frame.frameId) || seen.has(frame.frameId))
      throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_INVALID");
    if (frame.sequence !== index + 1) throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_SEQUENCE_GAP");
    if (!validTime(frame.capturedAtMicros))
      throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_CLOCK_INVALID");
    seen.add(frame.frameId);
  }
  // Chromium stamps metadata before asynchronous image encoding. Transport can
  // therefore deliver an older frame after a newer one. Retain receipt sequence
  // as provenance and derive a separate stable presentation order; never mutate
  // receipts, renumber capture sequence, or drop the late frame.
  const ordered = [...input.frames].sort(
    (a, b) => a.capturedAtMicros - b.capturedAtMicros || a.sequence - b.sequence,
  );
  const origin = ordered[0]!.capturedAtMicros;
  for (const [index, frame] of ordered.entries()) {
    const relative = frame.capturedAtMicros - origin;
    const point = Math.max(Math.round(relative / tickMicros), index ? points[index - 1]! + 1 : 0);
    const error = Math.abs(point * tickMicros - relative);
    maximumError = Math.max(maximumError, error);
    if (error > maximumTimingErrorMicros)
      throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_PRECISION_UNSUPPORTED");
    points.push(point);
  }
  if (input.endedAtMicros < ordered.at(-1)!.capturedAtMicros || input.endedAtMicros <= origin)
    throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_CLOCK_INVALID");
  const end = Math.max(points.at(-1)! + 1, Math.round((input.endedAtMicros - origin) / tickMicros));
  const endError = Math.abs(end * tickMicros - (input.endedAtMicros - origin));
  maximumError = Math.max(maximumError, endError);
  if (endError > maximumTimingErrorMicros)
    throw new Error("SCRY_BROWSER_NATIVE_TIMELINE_PRECISION_UNSUPPORTED");
  const frames = ordered.map((frame, index) =>
    Object.freeze({
      ...frame,
      presentationOrdinal: index + 1,
      presentationTimeMs: points[index]!,
      durationMs: (points[index + 1] ?? end) - points[index]!,
    }),
  );
  return Object.freeze({
    streamId: input.streamId,
    originAtMicros: origin,
    endedAtMicros: input.endedAtMicros,
    durationMs: end,
    maximumTimingErrorMicros: maximumError,
    frames: Object.freeze(frames),
    terminalRepeat: Object.freeze({ frameId: frames.at(-1)!.frameId, presentationTimeMs: end }),
  });
}

/** Private encoder input. Resolve only already-authorized protected frame files.
 * No URL, relative path, newline directive, or NUL can become an ffconcat entry.
 */
export function createNativeConcat(
  input: NativeTimelineInput,
  resolveFramePath: (frameId: string) => string,
): { timeline: NativeTimeline; concat: string } {
  const timeline = planNativeTimeline(input),
    files = new Map<string, string>();
  const quote = (frameId: string) => {
    const cached = files.get(frameId);
    if (cached) return cached;
    const filename = resolveFramePath(frameId);
    if (!path.isAbsolute(filename) || /[\r\n\0]/u.test(filename))
      throw new Error("SCRY_BROWSER_NATIVE_FRAME_PATH_INVALID");
    const value = "'" + filename.replaceAll("'", "'\\''") + "'";
    files.set(frameId, value);
    return value;
  };
  const lines: string[] = [];
  for (const frame of timeline.frames)
    lines.push(
      `file ${quote(frame.frameId)}`,
      "option framerate 1000",
      `duration ${(frame.durationMs / 1000).toFixed(6)}`,
    );
  lines.push(`file ${quote(timeline.terminalRepeat.frameId)}`, "option framerate 1000");
  return { timeline, concat: lines.join("\n") + "\n" };
}
