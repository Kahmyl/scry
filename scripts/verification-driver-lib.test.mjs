import assert from "node:assert/strict";
import test from "node:test";

import {
  failedWorkspaceNames,
  focusedWorkspaceNames,
  mergeFailureState,
  normalizeDriverArguments,
  workspaceFromResultId,
  workspaceWasFullyHealthy,
} from "./verification-driver-lib.mjs";

test("driver strips pnpm separator and consumes audit flag", () => {
  assert.deepEqual(
    normalizeDriverArguments(["--", "--audit", "--files", "packages/veil/src/index.ts"]),
    {
      audit: true,
      affectedArguments: ["--files", "packages/veil/src/index.ts"],
    },
  );
});

test("workspace is recovered from verification result ids", () => {
  assert.equal(workspaceFromResultId("@scry/executor:test:focused-impact"), "@scry/executor");

  assert.equal(workspaceFromResultId("root:verify:playwright"), null);
});

test("failed workspace state ignores root gates because root gates always rerun", () => {
  assert.deepEqual(
    failedWorkspaceNames([
      {
        id: "root:verify:playwright",
        passed: false,
      },
      {
        id: "@scry/api:test",
        passed: false,
      },
      {
        id: "@scry/praxis:test",
        passed: true,
      },
    ]),
    ["@scry/api"],
  );
});

test("focused workspaces are extracted from the selected plan", () => {
  assert.deepEqual(
    focusedWorkspaceNames({
      selected: [
        {
          name: "@scry/api",
          verification: {
            testMode: "focused",
          },
        },
        {
          name: "@scry/veil",
          verification: {
            testMode: "full",
          },
        },
        {
          name: "@scry/executor",
          verification: {
            testMode: "focused",
          },
        },
      ],
    }),
    ["@scry/api", "@scry/executor"],
  );
});

test("a workspace counts healthy only when its selected strategy was full and all commands passed", () => {
  const workspace = {
    name: "@scry/api",
    verification: {
      testMode: "full",
    },
  };

  assert.equal(
    workspaceWasFullyHealthy(workspace, [
      {
        id: "@scry/api:typecheck",
        passed: true,
      },
      {
        id: "@scry/api:test",
        passed: true,
      },
    ]),
    true,
  );

  assert.equal(
    workspaceWasFullyHealthy(
      {
        ...workspace,
        verification: {
          testMode: "focused",
        },
      },
      [
        {
          id: "@scry/api:test:focused-impact",
          passed: true,
        },
      ],
    ),
    false,
  );
});

test("prior failures remain selected until a full healthy verification clears them", () => {
  assert.deepEqual(
    mergeFailureState({
      priorWorkspaces: ["@scry/api", "@scry/executor"],
      currentFailedWorkspaces: [],
      fullChecks: [
        {
          workspace: "@scry/api",
          passed: true,
        },
        {
          workspace: "@scry/executor",
          passed: false,
        },
      ],
      fullyHealthyWorkspaces: [],
      knownWorkspaces: ["@scry/api", "@scry/executor"],
    }),
    ["@scry/executor"],
  );
});
