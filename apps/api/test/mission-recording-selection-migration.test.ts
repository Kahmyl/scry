import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_D647_FINGERPRINT,
  expandBaselineStage,
  OPTIONAL_BASELINE_MIGRATIONS,
} from "../scripts/migration-fingerprint-compatibility.js";

const deployedPreGapFingerprint =
  "d647df341b454e74f0e2263dc7e54c4c41b05e440b59adceac5566ef5d7a05c3";

const unknownFenceMigration = "20260820-0910_scope_unknown_fence_to_resource_mutations.sql";

const gapMigration = "20260816-231045_add_document_transition_gap.sql";

const selectionMigration = "mission-recording-selection.sql";

const operationalEventsMigration = "operational-events.sql";
const missionDiagnosticIsolationMigration = "mission-diagnostic-isolation.sql";
const preOperationalEventsFingerprint =
  "8abcde60d523d2e8390a686a591c4435efee6331baf15a2468743a1c8cb65a4f";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

const historicalFixtureDirectory = fileURLToPath(new URL("./fixtures/d647/", import.meta.url));

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
  it("reconstructs the deployed predecessor before the terminal R0.7 migrations", async () => {
    const { baseline, sources, expandFoundation } = await currentInputs();

    // Exact be31a6d7a3655ef21c99520632722fecdfd65741 source. This is the only
    // included predecessor migration body that differs from the current tree.
    const historicalProjection = await readFile(
      `${historicalFixtureDirectory}protected-operation-authoritative-projection.sql`,
      "utf8",
    );

    expect(digest(historicalProjection)).toBe(
      "6b31d4d5cb45ae036c8ec01e653048da6432ecf22dde08c22fc39d941b564439",
    );

    sources["protected-operation-authoritative-projection.sql"] = historicalProjection;

    const deployed = expandFoundation(
      expandBaselineStage(
        baseline,
        sources,
        OPTIONAL_BASELINE_MIGRATIONS.filter(
          (name) =>
            name !== unknownFenceMigration &&
            name !== gapMigration &&
            name !== selectionMigration &&
            name !== operationalEventsMigration &&
            name !== missionDiagnosticIsolationMigration,
        ),
      ),
    );

    expect(AUTHORITATIVE_D647_FINGERPRINT).toBe(deployedPreGapFingerprint);
    expect(digest(deployed)).toBe(AUTHORITATIVE_D647_FINGERPRINT);
  });

  it("models a distinct gap-applied pre-selection stage", async () => {
    const { baseline, sources, expandFoundation } = await currentInputs();

    const preSelection = expandFoundation(
      expandBaselineStage(
        baseline,
        sources,
        OPTIONAL_BASELINE_MIGRATIONS.filter(
          (name) =>
            name !== selectionMigration &&
            name !== operationalEventsMigration &&
            name !== missionDiagnosticIsolationMigration,
        ),
      ),
    );

    expect(preSelection).toContain("document_transition_gap");

    expect(digest(preSelection)).not.toBe(deployedPreGapFingerprint);
  });

  it("models the exact current predecessor and applies only the additive operational store", async () => {
    const { baseline, sources, expandFoundation } = await currentInputs();
    const predecessor = expandFoundation(
      expandBaselineStage(
        baseline,
        sources,
        OPTIONAL_BASELINE_MIGRATIONS.filter(
          (name) =>
            name !== operationalEventsMigration && name !== missionDiagnosticIsolationMigration,
        ),
      ),
    );
    expect(digest(predecessor)).toBe(preOperationalEventsFingerprint);

    const migrate = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");
    const block = migrate.match(
      /if \(installedFingerprint === preOperationalEventsFingerprint\) \{([\s\S]*?)\n\s*\} else if/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toContain("await client.query(operationalEvents);");
    expect(block![1]).not.toContain("missionRecordingSelection");
  });

  it("orders unknown fencing and document-transition authority before recording selection", async () => {
    const baseline = await readMigration("baseline.sql");

    const unknownFence = `\\ir ${unknownFenceMigration}`;

    const gap = `\\ir ${gapMigration}`;

    const selection = `\\ir ${selectionMigration}`;

    expect(baseline).toContain(unknownFence);

    expect(baseline).toContain(gap);

    expect(baseline).toContain(selection);

    expect(baseline.indexOf(unknownFence)).toBeLessThan(baseline.indexOf(gap));

    expect(baseline.indexOf(gap)).toBeLessThan(baseline.indexOf(selection));
  });

  it("upgrades the authoritative d647 predecessor through every current terminal delta", async () => {
    const migrate = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

    const d647Block = migrate.match(
      /if \(installedFingerprint === AUTHORITATIVE_D647_FINGERPRINT\) \{([\s\S]*?)\n\s*\} else if/,
    );

    expect(d647Block).not.toBeNull();

    const body = d647Block?.[1];

    if (body === undefined) throw new Error("EXPECTED_D647_UPGRADE_BRANCH_BODY");

    const projection = body.indexOf(
      "await client.query(protectedOperationAuthoritativeProjection);",
    );

    const unknownFence = body.indexOf("await client.query(scopeUnknownFenceToResourceMutations);");

    const gap = body.indexOf("await client.query(documentTransitionGap);");

    const selection = body.indexOf("await client.query(missionRecordingSelection);");

    const operationalEvents = body.indexOf("await client.query(operationalEvents);");

    expect(projection).toBeGreaterThanOrEqual(0);
    expect(projection).toBeLessThan(unknownFence);
    expect(unknownFence).toBeLessThan(gap);
    expect(gap).toBeLessThan(selection);
    expect(selection).toBeLessThan(operationalEvents);
    expect(body).toContain("UPDATE schema_baseline");
  });

  it("applies selection before every compatibility jump and gap everywhere except the already-gap-applied stage", async () => {
    const migrate = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

    const selectionCalls =
      migrate.match(/await client\.query\(missionRecordingSelection\);/g) ?? [];

    const operationalEventsCalls =
      migrate.match(/await client\.query\(operationalEvents\);/g) ?? [];

    const gapCalls = migrate.match(/await client\.query\(documentTransitionGap\);/g) ?? [];

    const unknownFenceCalls =
      migrate.match(/await client\.query\(scopeUnknownFenceToResourceMutations\);/g) ?? [];

    const finalWrites =
      migrate.match(/UPDATE\s+schema_baseline[\s\S]{0,160}?schema_fingerprint=\$1/g) ?? [];

    expect(operationalEventsCalls).toHaveLength(finalWrites.length - 1);

    expect(selectionCalls).toHaveLength(finalWrites.length - 2);

    expect(gapCalls).toHaveLength(selectionCalls.length - 1);

    expect(unknownFenceCalls).toHaveLength(selectionCalls.length - 1);

    expect(migrate).not.toContain("preDocumentTransitionGapFingerprint");

    const preSelectionBlock = migrate.match(
      /else if \(installedFingerprint === preMissionRecordingSelectionFingerprint\) \{([\s\S]*?)\n\s*\} else if/,
    );

    expect(preSelectionBlock).not.toBeNull();

    expect(preSelectionBlock![1]).toContain("missionRecordingSelection");

    expect(preSelectionBlock![1]).not.toContain("documentTransitionGap");
  });
});
