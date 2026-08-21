import { describe, expect, it } from "vitest";

type RecordIdentity = {
  id: string;
  stable: boolean;
  public: boolean;
  correlated?: boolean;
  timestamp?: string;
};

function derivePostCreationIdentity(before: RecordIdentity[], after: RecordIdentity[]) {
  const beforeIds = new Set(before.map(({ id }) => id));
  const added = after.filter(({ id }) => !beforeIds.has(id));
  if (
    added.length !== 1 ||
    !added[0]!.stable ||
    !added[0]!.public ||
    added[0]!.timestamp === added[0]!.id
  )
    return undefined;
  return added[0]!.id;
}

describe("post-creation external identity characterization", () => {
  const existing = { id: "record-a", stable: true, public: true };
  const created = { id: "record-b", stable: true, public: true };

  it("A/G: accepts exactly one new stable public record", () => {
    expect(derivePostCreationIdentity([existing], [existing, created])).toBe("record-b");
  });
  it("B: rejects two new records", () => {
    expect(
      derivePostCreationIdentity([existing], [existing, created, { ...created, id: "record-c" }]),
    ).toBeUndefined();
  });
  it("C: rejects unrelated concurrent change", () => {
    expect(
      derivePostCreationIdentity([existing], [created, { ...created, id: "unrelated" }]),
    ).toBeUndefined();
  });
  it("D: rejects no new identity", () => {
    expect(derivePostCreationIdentity([existing], [existing])).toBeUndefined();
  });
  it("E: ignores record reordering", () => {
    expect(derivePostCreationIdentity([existing, created], [created, existing])).toBeUndefined();
  });
  it("F: rejects timestamp-only identity", () => {
    expect(
      derivePostCreationIdentity(
        [existing],
        [existing, { id: "2030-01-01", timestamp: "2030-01-01", stable: false, public: true }],
      ),
    ).toBeUndefined();
  });
  it("H: rejects a protected-only record", () => {
    expect(
      derivePostCreationIdentity([existing], [existing, { ...created, public: false }]),
    ).toBeUndefined();
  });
  it("I: response identity confirmed by after-state is strongest", () => {
    const derived = derivePostCreationIdentity([existing], [existing, created]);
    expect(derived === "record-b" && created.id === "record-b").toBe(true);
  });
  it("J: response and observed identity disagreement fails closed", () => {
    const derived = derivePostCreationIdentity([existing], [existing, created]);
    expect(derived === "record-c").toBe(false);
  });
});
