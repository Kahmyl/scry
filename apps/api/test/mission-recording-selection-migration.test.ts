import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  expandBaselineStage,
  OPTIONAL_BASELINE_MIGRATIONS,
} from "../scripts/migration-fingerprint-compatibility.js";

const deployedPreGapFingerprint =
  "d647df341b454e74f0e2263dc7e54c4c41b05e440b59adceac5566ef5d7a05c3";

const gapMigration = "20260816-231045_add_document_transition_gap.sql";

const selectionMigration = "mission-recording-selection.sql";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function readMigration(name: string) {
  return readFile(`${migrationDirectory}${name}`, "utf8");
}

async function currentInputs() {
  const baseline = await readMigration("baseline.sql");

  const sources = Object.fromEntries(
    await Promise.all(
      OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [name, await readMigration(name)]),
    ),
  ) as Record<(typeof OPTIONAL_BASELINE_MIGRATIONS)[number], string>;

  const calibration = await readMigration("calibration-foundation.sql");

  const protectedCapsule = await readMigration("protected-capsule.sql");

  const expandFoundation = (value: string) =>
    value
      .replace("\\ir calibration-foundation.sql", () => calibration)
      .replace("\\ir protected-capsule.sql", () => protectedCapsule);

  return {
    baseline,
    sources,
    expandFoundation,
  };
}

const digest = (source: string) => createHash("sha256").update(source).digest("hex");

describe("Mission recording selection migration", () => {
  it("reconstructs the deployed predecessor before BOTH new recording migrations", async () => {
    const { baseline, sources, expandFoundation } = await currentInputs();

    const deployed = expandFoundation(
      expandBaselineStage(
        baseline,
        sources,
        OPTIONAL_BASELINE_MIGRATIONS.filter(
          (name) => name !== gapMigration && name !== selectionMigration,
        ),
      ),
    );

    expect(digest(deployed)).toBe(deployedPreGapFingerprint);
  });

  it("models a distinct gap-applied pre-selection stage", async () => {
    const { baseline, sources, expandFoundation } = await currentInputs();

    const preSelection = expandFoundation(
      expandBaselineStage(
        baseline,
        sources,
        OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== selectionMigration),
      ),
    );

    expect(preSelection).toContain("document_transition_gap");

    expect(digest(preSelection)).not.toBe(deployedPreGapFingerprint);
  });

  it("orders document-transition authority before recording-selection authority", async () => {
    const baseline = await readMigration("baseline.sql");

    const gap = `\\ir ${gapMigration}`;

    const selection = `\\ir ${selectionMigration}`;

    expect(baseline).toContain(gap);

    expect(baseline).toContain(selection);

    expect(baseline.indexOf(gap)).toBeLessThan(baseline.indexOf(selection));
  });

  it("applies selection before every compatibility jump and gap everywhere except the already-gap-applied stage", async () => {
    const migrate = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

    const selectionCalls =
      migrate.match(/await client\.query\(missionRecordingSelection\);/g) ?? [];

    const gapCalls = migrate.match(/await client\.query\(documentTransitionGap\);/g) ?? [];

    const finalWrites =
      migrate.match(/UPDATE\s+schema_baseline[\s\S]{0,160}?schema_fingerprint=\$1/g) ?? [];

    expect(selectionCalls).toHaveLength(finalWrites.length);

    expect(gapCalls).toHaveLength(selectionCalls.length - 1);

    expect(migrate).toContain("preDocumentTransitionGapFingerprint");

    const preSelectionBlock = migrate.match(
      /else if \(installedFingerprint === preMissionRecordingSelectionFingerprint\) \{([\s\S]*?)\n\s*\} else if/,
    );

    expect(preSelectionBlock).not.toBeNull();

    expect(preSelectionBlock![1]).toContain("missionRecordingSelection");

    expect(preSelectionBlock![1]).not.toContain("documentTransitionGap");
  });
});
