import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  expandBaselineStage,
  OPTIONAL_BASELINE_MIGRATIONS,
  type OptionalBaselineMigration,
} from "../scripts/migration-fingerprint-compatibility.js";

const migrationRoot = new URL("../migrations/", import.meta.url);

describe("external-agent lifecycle migration", () => {
  it("preserves the exact previously released baseline as the guarded upgrade source", async () => {
    const sources = Object.fromEntries(
      await Promise.all(
        OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [
          name,
          await readFile(new URL(name, migrationRoot), "utf8"),
        ]),
      ),
    ) as Record<OptionalBaselineMigration, string>;
    const baseline = await readFile(new URL("baseline.sql", migrationRoot), "utf8");
    const calibration = await readFile(
      new URL("calibration-foundation.sql", migrationRoot),
      "utf8",
    );
    const capsule = await readFile(new URL("protected-capsule.sql", migrationRoot), "utf8");
    const previous = expandBaselineStage(
      baseline,
      sources,
      OPTIONAL_BASELINE_MIGRATIONS.filter(
        (name) =>
          name !== "external-agent-lifecycle.sql" &&
          name !== "pre-mission-external-agent-lifecycle.sql" &&
          name !== "flow-name-identity-cutover.sql" &&
          name !== "targeted-region-perception.sql" &&
          name !== "system-correctness-m4-reconciliation-lease.sql" &&
          name !== "qualification-campaign-safety.sql" &&
          name !== "authoritative-q5-qualification.sql",
      ),
    )
      .replace("\\ir calibration-foundation.sql", () => calibration)
      .replace("\\ir protected-capsule.sql", () => capsule);

    expect(createHash("sha256").update(previous).digest("hex")).toBe(
      "ebbbf9d86305999f6cdfda6e1d980d36736619c271fb69a70a3f62665e09dadc",
    );
  });

  it("preserves the released post-Mission lifecycle baseline before the additive pre-Mission upgrade", async () => {
    const sources = Object.fromEntries(
      await Promise.all(
        OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [
          name,
          await readFile(new URL(name, migrationRoot), "utf8"),
        ]),
      ),
    ) as Record<OptionalBaselineMigration, string>;
    const baseline = await readFile(new URL("baseline.sql", migrationRoot), "utf8");
    const calibration = await readFile(
      new URL("calibration-foundation.sql", migrationRoot),
      "utf8",
    );
    const capsule = await readFile(new URL("protected-capsule.sql", migrationRoot), "utf8");
    const previous = expandBaselineStage(
      baseline,
      sources,
      OPTIONAL_BASELINE_MIGRATIONS.filter(
        (name) =>
          name !== "pre-mission-external-agent-lifecycle.sql" &&
          name !== "flow-name-identity-cutover.sql" &&
          name !== "targeted-region-perception.sql" &&
          name !== "system-correctness-m4-reconciliation-lease.sql" &&
          name !== "qualification-campaign-safety.sql" &&
          name !== "authoritative-q5-qualification.sql",
      ),
    )
      .replace("\\ir calibration-foundation.sql", () => calibration)
      .replace("\\ir protected-capsule.sql", () => capsule);

    expect(createHash("sha256").update(previous).digest("hex")).toBe(
      "9aff049c5adfe3ada8e431d74995518a72b23657d3f9458e2407c6cc7b87c39e",
    );
  });

  it("adds provider-neutral provenance and a recoverable external-owner lease", async () => {
    const source = await readFile(
      fileURLToPath(new URL("external-agent-lifecycle.sql", migrationRoot)),
      "utf8",
    );
    expect(source).toContain("provider ~ '^[a-z0-9][a-z0-9._-]{0,99}$'");
    expect(source).toContain("model text");
    expect(source).toContain("external_run_id uuid");
    expect(source).toContain("experiment_id text");
    expect(source).toContain("heartbeat_at timestamptz");
    expect(source).toContain("lease_expires_at timestamptz");
    expect(source).toContain("termination_reason text");
  });

  it("makes Mission ownership optional while preserving project scope and terminal truth", async () => {
    const source = await readFile(
      fileURLToPath(new URL("pre-mission-external-agent-lifecycle.sql", migrationRoot)),
      "utf8",
    );
    expect(source).toContain("ALTER COLUMN mission_id DROP NOT NULL");
    expect(source).toContain("external_run_id IS NOT NULL");
    expect(source).toContain("agent_sessions_external_run_unique");
    expect(source).toContain("'blocked'");
    expect(source).toContain("blocker_code");
    expect(source).toContain("terminal_outcome");
  });
});
