import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
const envelope = runInNewContext(
  readFileSync(new URL("../src/native-mask-runtime.js", import.meta.url), "utf8") +
    "\nnativeWholeOwnerEnvelope",
);
const box = { left: 181, top: 295.40625, right: 617, bottom: 319.40625 };
it("keeps one owner mask independent of the admitted first-glyph ink", () => {
  const first = envelope(box, { left: 182, top: 300, right: 420, bottom: 315 }, 1),
    second = envelope(box, { left: 181, top: 298, right: 419, bottom: 317 }, 1);
  expect(first).toEqual(second);
  expect(first).toEqual({
    left: 180,
    top: 294.40625,
    right: 618,
    bottom: 320.40625,
    width: 438,
    height: 26,
  });
});
it.each([
  { left: 180, top: 300, right: 420, bottom: 315 },
  { left: 182, top: 294, right: 420, bottom: 315 },
  { left: 182, top: 300, right: 618, bottom: 315 },
  { left: 182, top: 300, right: 420, bottom: 320 },
  { left: NaN, top: 300, right: 420, bottom: 315 },
])(
  "withholds unsupported overhang or invalid ink instead of expanding the private-dependent mask",
  (ink) => {
    expect(envelope(box, ink, 1)).toBeNull();
  },
);
it("uses the same device-pixel guard for every side", () => {
  expect(envelope(box, { left: 182, top: 300, right: 420, bottom: 315 }, 0.5)).toMatchObject({
    left: 180.5,
    top: 294.90625,
    right: 617.5,
    bottom: 319.90625,
  });
});
it.each([0, -1, Infinity, NaN])("rejects an invalid device guard", (guard) => {
  expect(envelope(box, { left: 182, top: 300, right: 420, bottom: 315 }, guard)).toBeNull();
});
