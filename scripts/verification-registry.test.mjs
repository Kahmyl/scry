import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_IMPACT_PROFILES,
  impactProfilesByIds,
  verificationStrategyFor,
} from "./verification-registry.mjs";

function strategy(name, reasons) {
  return verificationStrategyFor({
    name,
    reasons,
  });
}

test("direct Executor change remains full", () => {
  assert.equal(
    strategy("@scry/executor", ["changed:packages/executor/src/index.ts"]).testMode,
    "full",
  );
});

test("direct Praxis change remains full", () => {
  assert.equal(strategy("@scry/praxis", ["changed:packages/praxis/src/index.ts"]).testMode, "full");
});

test("direct API change remains full", () => {
  assert.equal(strategy("@scry/api", ["changed:apps/api/src/main.ts"]).testMode, "full");
});

test("Veil narrows downstream Executor", () => {
  const result = strategy("@scry/executor", ["depends-on:@scry/veil"]);

  assert.equal(result.testMode, "focused");

  assert.deepEqual(result.profileIds, ["veil-protected-boundary"]);
});

test("Praxis narrows downstream Executor", () => {
  const result = strategy("@scry/executor", ["depends-on:@scry/praxis"]);

  assert.equal(result.testMode, "focused");

  assert.deepEqual(result.profileIds, ["praxis-execution-boundary"]);
});

test("Veil narrows downstream Praxis", () => {
  const result = strategy("@scry/praxis", ["depends-on:@scry/veil"]);

  assert.equal(result.testMode, "focused");

  assert.deepEqual(result.profileIds, ["veil-praxis-trust-boundary"]);

  assert.ok(result.tests.includes("test/veil-bridge.test.ts"));
});

test("Veil narrows downstream API", () => {
  const result = strategy("@scry/api", ["depends-on:@scry/veil"]);

  assert.equal(result.testMode, "focused");

  assert.deepEqual(result.profileIds, ["veil-api-integration-boundary"]);

  assert.ok(result.tests.includes("test/veil-endpoints.test.ts"));

  assert.ok(result.tests.includes("test/calibration-runner.test.ts"));
});

test("unreviewed dependency expands to full", () => {
  assert.equal(strategy("@scry/api", ["depends-on:@scry/contracts"]).testMode, "full");
});

test("mixed reviewed and unreviewed impact expands to full", () => {
  assert.equal(
    strategy("@scry/executor", ["depends-on:@scry/veil", "depends-on:@scry/contracts"]).testMode,
    "full",
  );
});

test("unprofiled workspaces retain conservative full strategy", () => {
  assert.equal(strategy("@scry/assurance", ["depends-on:@scry/veil"]).testMode, "full");
});

test("profile ids are workspace scoped", () => {
  assert.throws(
    () => impactProfilesByIds("@scry/api", ["veil-protected-boundary"]),
    /Unknown impact profile/,
  );
});

test("expensive authoring lab remains absent from downstream profiles", () => {
  for (const profile of WORKSPACE_IMPACT_PROFILES) {
    assert.equal(
      profile.tests.includes("test/experiments/protected-authoring-system-journey-lab.test.ts"),
      false,
    );
  }
});
