const PROFILES = [
  {
    id: "veil-protected-boundary",
    workspace: "@scry/executor",
    workspacePath: "packages/executor",
    triggeredBy: "@scry/veil",
    capabilities: [
      "veil.disclosure",
      "veil.capture-boundary",
      "protected.transaction",
      "protected.acquisition",
      "protected.evidence",
    ],
    tests: [
      "test/protected-transaction-coordinator.test.ts",
      "test/protected-acquisition-adapters.test.ts",
      "test/protected-extractor.test.ts",
      "test/protected-extractor-deadline.test.ts",
      "test/protected-response-envelope.test.ts",
      "test/protected-response-correlation.playwright.test.ts",
      "test/protected-response-redirect-lifecycle.characterization.test.ts",
      "test/protected-stage-supervisor.test.ts",
      "test/probe-veil-boundary.test.ts",
      "test/privacy-gauntlet.test.ts",
      "test/veil-visual-capture.test.ts",
      "test/veil-visual-capture-csp.test.ts",
      "test/veil-policy-adapter.test.ts",
      "test/trace-coordinator-admission.test.ts",
      "test/evidence-runtime-visual-permit-stabilization.test.ts",
      "test/executor-sealed-recording-secret-fill.test.ts",
      "test/protected-transaction-acquisition.test.ts",
      "test/protected-preparation-effects.test.ts",
      "test/executor-protected-assertion-identity.test.ts",
    ],
  },
  {
    id: "praxis-execution-boundary",
    workspace: "@scry/executor",
    workspacePath: "packages/executor",
    triggeredBy: "@scry/praxis",
    capabilities: [
      "praxis.grounding",
      "praxis.target-reference",
      "praxis.execution",
      "praxis.navigation",
      "praxis.readiness",
    ],
    tests: [
      "test/grounding.test.ts",
      "test/execution-kernel.test.ts",
      "test/capability-grounding-gauntlet.test.ts",
      "test/dom-stable-readiness.test.ts",
      "test/native-browser-navigation.test.ts",
      "test/authoring-browser-grounding.test.ts",
      "test/authoring-browser-session.test.ts",
      "test/probe-veil-boundary.test.ts",
      "test/external-resource-target-preparation.test.ts",
      "test/interaction-lifecycle.test.ts",
      "test/checkpoint-and-adapters.test.ts",
    ],
  },
  {
    id: "veil-praxis-trust-boundary",
    workspace: "@scry/praxis",
    workspacePath: "packages/praxis",
    triggeredBy: "@scry/veil",
    capabilities: [
      "veil.disclosure",
      "praxis.veil-bridge",
      "praxis.protected-scope",
      "praxis.transaction",
      "praxis.browser-boundary",
    ],
    tests: [
      "test/veil-bridge.test.ts",
      "test/transaction.test.ts",
      "test/protected-scope-conformance.test.ts",
      "test/browser-runtime-artifacts.test.ts",
      "test/runtime.test.ts",
      "test/risk-policy.test.ts",
    ],
  },
  {
    id: "veil-api-integration-boundary",
    workspace: "@scry/api",
    workspacePath: "apps/api",
    triggeredBy: "@scry/veil",
    capabilities: [
      "veil.api",
      "veil.policy",
      "protected.interaction",
      "protected.persistence",
      "protected.calibration",
      "protected.browser-boundary",
    ],
    tests: [
      "test/veil-endpoints.test.ts",
      "test/veil-policy-snapshot.test.ts",
      "test/protected-interaction-conformance.test.ts",
      "test/project-configuration-protected-session-admission.test.ts",
      "test/protected-output-persistence.repository.test.ts",
      "test/protected-probe-calibration-kernel.test.ts",
      "test/protected-input-capability.test.ts",
      "test/protected-operation.repository.test.ts",
      "test/calibration-runtime.repository.test.ts",
      "test/calibration-runner.test.ts",
      "test/native-browser-driver.test.ts",
      "test/praxis-endpoints.test.ts",
    ],
  },
];

export const WORKSPACE_IMPACT_PROFILES = Object.freeze(
  PROFILES.map((profile) =>
    Object.freeze({
      ...profile,
      capabilities: Object.freeze([...profile.capabilities]),
      tests: Object.freeze([...profile.tests]),
    }),
  ),
);

const DIRECT_PREFIXES = Object.freeze({
  "@scry/executor": "packages/executor/",
  "@scry/praxis": "packages/praxis/",
  "@scry/api": "apps/api/",
});

export function impactProfilesForWorkspace(workspaceName) {
  return WORKSPACE_IMPACT_PROFILES.filter((profile) => profile.workspace === workspaceName);
}

export function impactProfilesByIds(workspaceName, profileIds) {
  const available = impactProfilesForWorkspace(workspaceName);

  return profileIds.map((id) => {
    const profile = available.find((candidate) => candidate.id === id);

    if (!profile) {
      throw new Error(`Unknown impact profile "${id}" for ${workspaceName}`);
    }

    return profile;
  });
}

export function verificationStrategyFor(workspace) {
  const available = impactProfilesForWorkspace(workspace.name);

  if (available.length === 0) {
    return {
      testMode: "full",
      reason: "workspace-level-conservative-default",
      profileIds: [],
      capabilities: [],
      tests: [],
    };
  }

  const directPrefix = DIRECT_PREFIXES[workspace.name];

  if (
    directPrefix &&
    workspace.reasons.some((reason) => reason.startsWith(`changed:${directPrefix}`))
  ) {
    return {
      testMode: "full",
      reason: `${workspace.name.replace("@scry/", "")}-direct-change`,
      profileIds: [],
      capabilities: [],
      tests: [],
    };
  }

  const selected = [];

  for (const reason of workspace.reasons) {
    if (!reason.startsWith("depends-on:")) {
      return {
        testMode: "full",
        reason: `unprofiled-impact:${reason}`,
        profileIds: [],
        capabilities: [],
        tests: [],
      };
    }

    const dependency = reason.slice("depends-on:".length);

    const profile = available.find((candidate) => candidate.triggeredBy === dependency);

    if (!profile) {
      return {
        testMode: "full",
        reason: `unprofiled-impact:${reason}`,
        profileIds: [],
        capabilities: [],
        tests: [],
      };
    }

    selected.push(profile);
  }

  if (selected.length === 0) {
    return {
      testMode: "full",
      reason: "no-reviewed-semantic-profile",
      profileIds: [],
      capabilities: [],
      tests: [],
    };
  }

  return {
    testMode: "focused",
    reason: "reviewed-downstream-semantic-impact",
    profileIds: [...new Set(selected.map((profile) => profile.id))].sort(),
    capabilities: [...new Set(selected.flatMap((profile) => profile.capabilities))].sort(),
    tests: [...new Set(selected.flatMap((profile) => profile.tests))].sort(),
  };
}
