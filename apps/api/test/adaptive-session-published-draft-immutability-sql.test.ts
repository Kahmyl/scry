import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositoryUrl = new URL(
  "../src/adaptive-sessions/repositories/adaptive-session.repository.ts",
  import.meta.url,
);

async function repositorySource() {
  return readFile(repositoryUrl, "utf8");
}

function sourceSection(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("published Flow draft immutability", () => {
  it("fences every runtime authoring-step projection before mutating the draft", async () => {
    const source = await repositorySource();

    const sections = [
      sourceSection(
        source,
        "  private async writeProtectedProjection(",
        "  settleMissionOperation(input:",
      ),
      sourceSection(
        source,
        "  settleMissionOperation(input:",
        "  beginUnknownReconciliation(input:",
      ),
      sourceSection(
        source,
        "  completeUnknownReconciliation(input:",
        "  projectCredentialLifecycleForAuthoring(",
      ),
    ];

    const immutableGuard = '!["published", "abandoned"].includes(draft.rows[0]!.state)';

    for (const section of sections) {
      const guard = section.indexOf(immutableGuard);
      const mutation = section.indexOf("UPDATE flow_drafts SET plan=jsonb_set");
      const event = section.indexOf("authoring_step_appended");

      expect(guard).toBeGreaterThanOrEqual(0);
      expect(mutation).toBeGreaterThan(guard);
      expect(event).toBeGreaterThan(mutation);

      expect(section).toContain("state: string");
      expect(section).toContain("SELECT version,state");
    }
  });

  it("retains exactly three guarded authoring-step projection sites", async () => {
    const source = await repositorySource();

    expect(source.match(/UPDATE flow_drafts SET plan=jsonb_set/g) ?? []).toHaveLength(3);

    expect(
      source.match(/!\["published", "abandoned"\]\.includes\(draft\.rows\[0\]!\.state\)/g) ?? [],
    ).toHaveLength(3);
  });
});
