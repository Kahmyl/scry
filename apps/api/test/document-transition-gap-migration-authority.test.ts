import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const gap = "20260816-231045_add_document_transition_gap.sql";

const selection = "mission-recording-selection.sql";

describe("document transition gap migration authority", () => {
  it("is canonical fingerprint authority before recording selection", async () => {
    const baseline = await readFile(new URL("../migrations/baseline.sql", import.meta.url), "utf8");

    expect(baseline.indexOf(`\\ir ${gap}`)).toBeGreaterThanOrEqual(0);

    expect(baseline.indexOf(`\\ir ${gap}`)).toBeLessThan(baseline.indexOf(`\\ir ${selection}`));
  });

  it("is included in optional current expansion and stripped from released compatibility reconstruction", async () => {
    const compatibility = await readFile(
      new URL("../scripts/migration-fingerprint-compatibility.ts", import.meta.url),
      "utf8",
    );

    const occurrences =
      compatibility.match(/20260816-231045_add_document_transition_gap\.sql/g) ?? [];

    // One in OPTIONAL_BASELINE_MIGRATIONS,
    // one in compatibilityBaseline().
    expect(occurrences).toHaveLength(2);
  });

  it("uses the authoritative d647 predecessor branch to apply gap then selection", async () => {
    const migrate = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

    const match = migrate.match(
      /if \(installedFingerprint === AUTHORITATIVE_D647_FINGERPRINT\) \{([\s\S]*?)\n\s*\} else if/,
    );

    expect(match).not.toBeNull();

    const body = match?.[1];

    if (body === undefined) throw new Error("EXPECTED_DEPLOYED_PREDECESSOR_BRANCH_BODY");

    expect(body).toContain("documentTransitionGap");

    expect(body).toContain("missionRecordingSelection");

    expect(body.indexOf("documentTransitionGap")).toBeLessThan(
      body.indexOf("missionRecordingSelection"),
    );
  });
});
