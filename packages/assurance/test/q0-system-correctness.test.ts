import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { correctnessManifest } from "../src/architecture/q0/manifest.js";
import { createQ0Report } from "../src/architecture/q0/report.js";
import {
  createProductionSnapshot,
  runNegativeControls,
  validateQ0Manifest,
} from "../src/architecture/q0/validator.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Q0 system-correctness manifest", () => {
  it("matches current production state and transition authorities", async () => {
    const snapshot = await createProductionSnapshot(root);
    const findings = await validateQ0Manifest(root, correctnessManifest, snapshot);

    expect(findings).toEqual([]);
  });

  it("retains the accepted traceability inventory without forcing hidden authority", () => {
    expect(correctnessManifest.machines).toHaveLength(28);
    expect(correctnessManifest.invariants).toHaveLength(52);
    expect(correctnessManifest.boundaries).toHaveLength(20);
    expect(correctnessManifest.timersAndLeases).toHaveLength(21);
    expect(correctnessManifest.authorityDomains).toHaveLength(15);
    expect(correctnessManifest.risks.filter(({ level }) => level === "P0")).toHaveLength(4);
    expect(correctnessManifest.risks.filter(({ level }) => level === "P1")).toHaveLength(11);

    expect(
      correctnessManifest.machines.find(({ id }) => id === "machine.authoring_session_role")
        ?.classification,
    ).toBe("current_logical_identity");
    expect(correctnessManifest.authorityRule).toBe(
      "production_authority_plus_independent_drift_detector",
    );
  });

  it("classifies every legacy overlay", () => {
    expect(
      correctnessManifest.legacyOverlays.filter(
        ({ classification }) => classification === "unresolved_from_static_source",
      ),
    ).toEqual([]);
  });

  it("makes all six negative controls fail with stable Q0 reason IDs", async () => {
    const snapshot = await createProductionSnapshot(root);
    const results = await runNegativeControls(root, correctnessManifest, snapshot);

    expect(results).toHaveLength(6);
    expect(results.every(({ passed }) => passed)).toBe(true);
    expect(results.map(({ expectedReasonId }) => expectedReasonId)).toEqual([
      "Q0_DUPLICATE_AUTHORITATIVE_OWNER",
      "Q0_STALE_ARCHITECTURE_CANONICAL",
      "Q0_UNKNOWN_PRODUCTION_STATE",
      "Q0_UNCLASSIFIED_LEGACY_OVERLAY",
      "Q0_BOUNDARY_RECOVERY_OWNER_MISSING",
      "Q0_REQUEST_LOADER_DOCUMENT_AUTHORITY",
    ]);
  });

  it("generates a deterministic report for unchanged source", async () => {
    const first = await createQ0Report(root);
    const second = await createQ0Report(root);

    expect(second).toEqual(first);
    expect(first.report.milestoneStatus).toBe("PASS");
    expect(first.report.stabilizationReadiness).toBe("Q1_ELIGIBLE");
    expect(first.report.ownershipAdjudications).toHaveLength(3);
    expect(first.report.ownershipAdjudications.every(({ blocker }) => !blocker)).toBe(true);
    expect(
      first.report.ownershipAdjudications.every(
        ({ classification }) => classification === "layered_ownership",
      ),
    ).toBe(true);
  });

  it("is never imported by production runtime source", async () => {
    const productionFiles = await collectTypeScript([
      path.join(root, "apps"),
      path.join(root, "packages/chronicle/src"),
      path.join(root, "packages/contracts/src"),
      path.join(root, "packages/executor/src"),
      path.join(root, "packages/observability/src"),
      path.join(root, "packages/policy/src"),
      path.join(root, "packages/praxis/src"),
      path.join(root, "packages/veil/src"),
    ]);

    for (const file of productionFiles) {
      const contents = await readFile(file, "utf8");
      expect(contents, file).not.toMatch(/assurance\/src\/architecture\/q0|architecture\/q0/);
    }
  });
});

async function collectTypeScript(roots: string[]): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  for (const rootDirectory of roots) {
    for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
      const target = path.join(rootDirectory, entry.name);
      if (entry.isDirectory()) files.push(...(await collectTypeScript([target])));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
    }
  }
  return files;
}
