import { describe, it, expect } from "vitest";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";
const epoch = (n: number) => ({
  captureId: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
  originalWriterGeneration: 1,
  assessmentPolicyVersion: 2 as const,
});
const facts = (read: number, values: string[] = []) => ({
  version: 1,
  readId: read,
  policyGeneration: 1,
  text: "complete",
  image: { state: "available", assessment: "best_effort_known_candidates" },
  knownRequirement: "absent_in_supported_snapshot",
  values,
  coveredBoundIndices: [],
  textCandidateScope: { readId: read, policyGeneration: 1 },
  textCandidateRefs: [],
  imageCandidateRefs: [],
  count: {
    roots: 1,
    nodes: 1,
    textNodes: 0,
    controls: 0,
    presentations: 0,
    pseudoReads: 0,
    rectangles: 0,
  },
});
function ready(
  p: ReturnType<typeof createNativeAdapterProtector>,
  values: string[] = [],
  admitted = true,
) {
  const read = p.beginNativeRead();
  expect(p.acceptNativeRead(read, facts(read, values), { pageId: 0, worldId: 0 })).toBe(admitted);
  p.finishNativeRead(read, true, 0);
  return read;
}
describe("shared native privacy owner", () => {
  it("shares bounded privacy history while keeping per-capture observed gaps independent", () => {
    const root = createNativeAdapterProtector({}),
      a = root.fork(epoch(1)),
      b = root.fork(epoch(2)),
      value = "fictional-opaque-private-value";
    ready(a);
    const out = a.cleanTextContent(
      [{ type: "text", text: '- textbox "Private token": ' + value }],
      true,
    );
    expect(out[0]?.text).not.toContain(value);
    expect(a.imageEvidence().state).toBe("withheld");
    expect(a.drainGaps()).toEqual(["native_protection_geometry_unsupported"]);
    ready(b);
    expect(String(b.clean(value))).not.toContain(value);
    expect(b.drainGaps()).toEqual([]);
    a.dispose();
    expect(String(b.clean(value))).not.toContain(value);
    root.dispose();
    expect(String(b.clean(value))).not.toContain(value);
    b.dispose();
  });
  it("enforces one discovery budget across views and never recovers lost history on a new receipt", () => {
    const root = createNativeAdapterProtector({}),
      a = root.fork(epoch(1)),
      b = root.fork(epoch(2));
    ready(
      a,
      Array.from({ length: 80 }, (_, i) => "first-private-" + i),
    );
    ready(
      b,
      Array.from({ length: 80 }, (_, i) => "second-private-" + i),
      false,
    );
    expect(a.imageEvidence()).toMatchObject({
      state: "withheld",
      reason: "native_protection_capacity",
    });
    expect(String(a.clean("public"))).toContain("UNAVAILABLE");
    ready(a, [], false);
    expect(a.observationAvailable()).toBe(false);
    root.dispose();
    a.dispose();
    b.dispose();
  });
  it("does not create unbounded revisions for value-identical binding updates", () => {
    const p = createNativeAdapterProtector({ selected: "fictional-bound-value" });
    for (let i = 0; i < 1000; i++) p.updateSecrets({ ["ref" + i]: "fictional-bound-value" });
    expect(p.policyGeneration).toBe(1);
    expect(p.documentUpdatesSince(0)).toHaveLength(0);
    p.updateSecrets({ another: "new-fictional-bound-value" });
    expect(p.policyGeneration).toBe(2);
    expect(p.documentUpdatesSince(0)).toHaveLength(1);
    p.dispose();
  });
  it("rejects stale facts before changing durable read or history state", () => {
    const p = createNativeAdapterProtector({});
    const old = p.beginNativeRead(),
      current = p.beginNativeRead();
    expect(
      p.acceptNativeRead(old, facts(old, ["should-not-be-retained"]), { pageId: 0, worldId: 0 }),
    ).toBe(false);
    expect(p.acceptNativeRead(current, facts(current), { pageId: 0, worldId: 0 })).toBe(true);
    p.finishNativeRead(current, true, 0);
    expect(p.clean("should-not-be-retained")).toBe("should-not-be-retained");
    expect(p.diagnosticDetailAllowed()).toBe(false);
    p.dispose();
  });
  it("exports only finite capture facts, with no private graph or history siblings", () => {
    const p = createNativeAdapterProtector({}, { captureEpoch: epoch(1) });
    ready(p, ["fictional-secret-history"]);
    const sample = p.captureSample();
    expect(Object.keys(sample).sort()).toEqual([
      "image",
      "knownRequirement",
      "policyGeneration",
      "readId",
      "text",
      "version",
    ]);
    expect(JSON.stringify(sample)).not.toContain("fictional-secret-history");
    p.dispose();
  });
});
