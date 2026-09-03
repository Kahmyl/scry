import type { Q3EvidenceMode, Q3FixtureMode, Q3ScenarioId } from "./types.js";

export type Q3ScenarioDefinition = Readonly<{
  id: Q3ScenarioId;
  title: string;
  mode: Q3FixtureMode;
  evidenceMode: Q3EvidenceMode;
  expectedRequests: number;
  expectedResources: number;
  expectedCleanupEffects?: number;
  relevantInvariantIds: readonly string[];
}>;

export const q3Scenarios: readonly Q3ScenarioDefinition[] = Object.freeze([
  scenario("Q3-01", "public docs, SPA, and worker", "NORMAL", "OPTIONAL_AVAILABLE", 0, 0, [
    "A01",
    "A02",
    "A04",
    "Q03",
  ]),
  scenario("Q3-02", "stale exact reference", "NORMAL", "OPTIONAL_AVAILABLE", 0, 0, [
    "A01",
    "A02",
    "A03",
    "M05",
    "Q03",
  ]),
  scenario("Q3-03", "protected login", "NORMAL", "OPTIONAL_SUPPRESSED", 0, 0, [
    "A05",
    "P01",
    "P02",
    "P03",
    "P05",
    "Q03",
  ]),
  scenario("Q3-04", "authenticated read", "NORMAL", "OPTIONAL_AVAILABLE", 0, 0, [
    "M07",
    "P01",
    "Q03",
  ]),
  scenario("Q3-05", "normal exactly-once create", "NORMAL", "REQUIRED_AVAILABLE", 1, 1, [
    "M01",
    "M02",
    "M05",
    "A06",
    "P04",
    "Q03",
  ]),
  scenario("Q3-06", "duplicate delivery negative control", "NORMAL", "REQUIRED_AVAILABLE", 2, 1, [
    "M02",
    "M09",
    "A06",
    "Q03",
  ]),
  scenario(
    "Q3-07",
    "commit and lost acknowledgement",
    "DROP_ACK_AFTER_COMMIT",
    "REQUIRED_AVAILABLE",
    1,
    1,
    ["M01", "M04", "M08", "M10", "R05", "Q03"],
  ),
  scenario(
    "Q3-08",
    "no commit and lost acknowledgement",
    "NO_COMMIT_DROP",
    "REQUIRED_AVAILABLE",
    1,
    0,
    ["M01", "M04", "M06", "M08", "R05", "Q03"],
  ),
  scenario("Q3-09", "bounded still unknown", "STILL_AMBIGUOUS", "REQUIRED_AVAILABLE", 1, 0, [
    "M04",
    "M08",
    "M10",
    "L04",
    "R05",
    "Q03",
  ]),
  scenario(
    "Q3-10",
    "effect verified then local persistence failure",
    "DELAYED_ACK",
    "REQUIRED_FAILED",
    1,
    1,
    ["M02", "T02", "T03", "T04", "P04", "Q03"],
  ),
  scenario("Q3-11", "required and optional evidence", "NORMAL", "REQUIRED_AVAILABLE", 0, 0, [
    "T02",
    "P04",
    "P05",
    "P07",
    "Q03",
  ]),
  scenario("Q3-12", "logical runtime and lease loss", "NORMAL", "REQUIRED_AVAILABLE", 1, 1, [
    "T04",
    "L04",
    "L09",
    "M10",
    "Q03",
  ]),
  scenario("Q3-13", "malformed historical recovery", "NORMAL", "OPTIONAL_AVAILABLE", 0, 0, [
    "M01",
    "M08",
    "M10",
    "R02",
    "R05",
    "Q03",
  ]),
  scenario(
    "Q3-14",
    "separately authorized cleanup",
    "RESPONSE_BEFORE_UI_PROJECTION",
    "REQUIRED_AVAILABLE",
    1,
    1,
    ["M02", "R06", "Q03"],
    1,
  ),
]);

function scenario(
  id: Q3ScenarioId,
  title: string,
  mode: Q3FixtureMode,
  evidenceMode: Q3EvidenceMode,
  expectedRequests: number,
  expectedResources: number,
  relevantInvariantIds: readonly string[],
  expectedCleanupEffects?: number,
): Q3ScenarioDefinition {
  return Object.freeze({
    id,
    title,
    mode,
    evidenceMode,
    expectedRequests,
    expectedResources,
    relevantInvariantIds,
    ...(expectedCleanupEffects === undefined ? {} : { expectedCleanupEffects }),
  });
}
