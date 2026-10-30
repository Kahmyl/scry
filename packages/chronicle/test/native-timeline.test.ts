import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planNativeTimeline, createNativeConcat } from "../src/native-timeline.js";

function fixture(offsets: readonly number[], end: number) {
  const streamId = randomUUID(),
    origin = 1761436800000000;
  const frames = offsets.map((offset, index) =>
    Object.freeze({
      streamId,
      frameId: randomUUID(),
      sequence: index + 1,
      capturedAtMicros: origin + offset,
    }),
  );
  return { streamId, frames: Object.freeze(frames), endedAtMicros: origin + end };
}
describe("native evidence presentation timeline", () => {
  it("preserves actual pacing and the final idle interval without a speed multiplier", () => {
    const input = fixture([0, 33000, 81000], 2081000),
      before = JSON.stringify(input),
      plan = planNativeTimeline(input);
    expect(plan.frames.map((frame) => frame.presentationTimeMs)).toEqual([0, 33, 81]);
    expect(plan.frames.map((frame) => frame.durationMs)).toEqual([33, 48, 2000]);
    expect(plan.durationMs).toBe(2081);
    expect(plan.terminalRepeat.presentationTimeMs).toBe(2081);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(plan.frames)).toBe(true);
    expect(Object.isFrozen(plan.frames[0])).toBe(true);
  });
  it("does not retain a permanent shift after a sub-millisecond capture interval", () => {
    const plan = planNativeTimeline(fixture([0, 738, 20300, 30200], 40200));
    expect(plan.frames.map((frame) => frame.presentationTimeMs)).toEqual([0, 1, 20, 30]);
    expect(plan.frames.map((frame) => frame.durationMs)).toEqual([1, 19, 10, 10]);
    expect(plan.maximumTimingErrorMicros).toBe(300);
  });
  it("bounds dense timestamp quantization and refuses unrepresentable bursts", () => {
    const two = planNativeTimeline(fixture([0, 100], 10000));
    expect(two.maximumTimingErrorMicros).toBe(900);
    expect(() => planNativeTimeline(fixture([0, 100, 200], 10000))).toThrow(
      "SCRY_BROWSER_NATIVE_TIMELINE_PRECISION_UNSUPPORTED",
    );
  });
  it("preserves capture sequence while presenting asynchronously delivered frames by native time", () => {
    const input = fixture([0, 100000, 38000, 120000], 200000),
      before = JSON.stringify(input);
    const plan = planNativeTimeline(input);
    expect(plan.frames.map((frame) => frame.sequence)).toEqual([1, 3, 2, 4]);
    expect(plan.frames.map((frame) => frame.presentationOrdinal)).toEqual([1, 2, 3, 4]);
    expect(plan.frames.map((frame) => frame.presentationTimeMs)).toEqual([0, 38, 100, 120]);
    expect(new Set(plan.frames.map((frame) => frame.frameId))).toEqual(
      new Set(input.frames.map((frame) => frame.frameId)),
    );
    expect(JSON.stringify(input)).toBe(before);
  });
  it("requires complete receipt order, unique frames and a single stream", () => {
    const input = fixture([0, 10000], 20000),
      frames = input.frames.map((frame) => ({ ...frame }));
    expect(() => planNativeTimeline({ ...input, frames: [frames[1]!, frames[0]!] })).toThrow(
      "SEQUENCE_GAP",
    );
    expect(() =>
      planNativeTimeline({ ...input, frames: [frames[0]!, { ...frames[1]!, sequence: 3 }] }),
    ).toThrow("SEQUENCE_GAP");
    expect(() =>
      planNativeTimeline({
        ...input,
        frames: [frames[0]!, { ...frames[1]!, frameId: frames[0]!.frameId }],
      }),
    ).toThrow("TIMELINE_INVALID");
    expect(() =>
      planNativeTimeline({
        ...input,
        frames: [frames[0]!, { ...frames[1]!, streamId: randomUUID() }],
      }),
    ).toThrow("SCOPE_MISMATCH");
  });
  it.each([NaN, Infinity, -1, 0.5])("rejects invalid source clock %s", (value) => {
    const input = fixture([0], 10000);
    expect(() =>
      planNativeTimeline({ ...input, frames: [{ ...input.frames[0]!, capturedAtMicros: value }] }),
    ).toThrow("CLOCK_INVALID");
  });
  it("rejects absent/early termination, empty input and excess work", () => {
    expect(() => planNativeTimeline(fixture([0, 10000], 9000))).toThrow("CLOCK_INVALID");
    expect(() => planNativeTimeline(fixture([0], 0))).toThrow("CLOCK_INVALID");
    expect(() => planNativeTimeline({ ...fixture([0], 10000), frames: [] })).toThrow(
      "TIMELINE_INVALID",
    );
    expect(() => planNativeTimeline({ ...fixture([0, 10000], 20000), maximumFrames: 1 })).toThrow(
      "CAPACITY",
    );
    expect(() => planNativeTimeline({ ...fixture([0], 10000), maximumFrames: Infinity })).toThrow(
      "CAPACITY",
    );
  });
  it("serializes private protected-file references and declares the terminal repeat", () => {
    const input = fixture([0, 10000], 20000),
      resolve = (id: string) => `/private/frames/${id}.png`,
      value = createNativeConcat(input, resolve);
    expect(value.concat.match(/^file /gmu)).toHaveLength(3);
    expect(value.concat.match(/^duration 0\.010000$/gmu)).toHaveLength(2);
    expect(
      value.concat.endsWith(`file '${resolve(input.frames[1]!.frameId)}'\noption framerate 1000\n`),
    ).toBe(true);
    expect(createNativeConcat(input, () => "/private/has ' quote.png").concat).toContain(
      "has '\\'' quote.png",
    );
  });
  it.each([
    "relative.png",
    "https://invalid/frame.png",
    "/private/a\noption protocol_whitelist all",
    "/private/a\0.png",
    "/private/a\r.png",
  ])("refuses an unsafe encoder path", (filename) => {
    expect(() => createNativeConcat(fixture([0], 10000), () => filename)).toThrow(
      "NATIVE_FRAME_PATH_INVALID",
    );
  });
});
