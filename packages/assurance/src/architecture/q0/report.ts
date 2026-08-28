import { execFileSync } from "node:child_process";

import { correctnessManifest } from "./manifest.js";
import {
  architectureSourceDigest,
  createProductionSnapshot,
  deterministicDigest,
  runNegativeControls,
  schemaFingerprint,
  validateQ0Manifest,
} from "./validator.js";

export async function createQ0Report(root: string) {
  const production = await createProductionSnapshot(root);
  const staticFindings = await validateQ0Manifest(root, correctnessManifest, production);
  const negativeControls = await runNegativeControls(root, correctnessManifest, production);
  const ownershipAdjudications = correctnessManifest.ownership
    .filter(({ status }) => status !== "single_owner")
    .map(({ id, concern, status, authoritativeOwner, layers, finding }) => ({
      id,
      concern,
      classification: status,
      authoritativeOwner,
      layers,
      finding,
      blocker: status === "genuine_duplicate_authority" || status === "unresolved",
    }));
  const ownershipBlockers = ownershipAdjudications.filter(({ blocker }) => blocker);
  const unclassifiedLegacyOverlays = correctnessManifest.legacyOverlays.filter(
    ({ classification }) => classification === "unresolved_from_static_source",
  );
  const negativeControlsPassed = negativeControls.every(({ passed }) => passed);
  const staticChecksPassed = staticFindings.length === 0;

  const report = {
    reportSchemaVersion: 1,
    qualification: "Q0",
    milestone: 1,
    milestoneStatus: staticChecksPassed && negativeControlsPassed ? "PASS" : "BLOCKED",
    stabilizationReadiness:
      ownershipBlockers.length || unclassifiedLegacyOverlays.length
        ? "BLOCKED_BY_DECLARED_ARCHITECTURE_FINDINGS"
        : "Q1_ELIGIBLE",
    authorityRule: correctnessManifest.authorityRule,
    manifestVersion: correctnessManifest.manifestVersion,
    sourceHead: git(root, ["rev-parse", "HEAD"]),
    architectureSourceDigest: await architectureSourceDigest(root, correctnessManifest),
    schemaFingerprint: schemaFingerprint(root),
    counts: {
      machines: correctnessManifest.machines.length,
      machineClassifications: countBy(correctnessManifest.machines, "classification"),
      legacyOverlays: correctnessManifest.legacyOverlays.length,
      legacyOverlayClassifications: countBy(correctnessManifest.legacyOverlays, "classification"),
      ownershipAdjudications: ownershipAdjudications.length,
      ownershipBlockers: ownershipBlockers.length,
      unresolvedLegacyOverlays: unclassifiedLegacyOverlays.length,
      truthDimensions: correctnessManifest.truthVector.length,
      invariants: correctnessManifest.invariants.length,
      boundaries: correctnessManifest.boundaries.length,
      timersAndLeases: correctnessManifest.timersAndLeases.length,
      authorityDomains: correctnessManifest.authorityDomains.length,
      conflictScopes: correctnessManifest.conflictScopes.length,
      p0Risks: correctnessManifest.risks.filter(({ level }) => level === "P0").length,
      p1Risks: correctnessManifest.risks.filter(({ level }) => level === "P1").length,
    },
    sourceCorrections: [
      {
        subject: "machine.agent_session",
        auditClaim: "active, completed, interrupted, failed",
        currentSource: "active, blocked, completed, interrupted, failed",
        resolution: "Manifest follows current contract and migration authority by adding blocked.",
      },
      {
        subject: "machine.authoring_session_role",
        auditClaim: "Tracked as a logical role in the 28-entry inventory.",
        currentSource:
          "No independent table or transition authority; role is bound over adaptive_sessions.",
        resolution:
          "Retained as a current logical identity and mechanically barred from becoming a second session authority.",
      },
    ],
    ownershipAdjudications,
    unclassifiedLegacyOverlays: unclassifiedLegacyOverlays.map(({ id, name }) => ({ id, name })),
    p0p1Traceability: correctnessManifest.risks.map(
      ({ id, level, invariantIds, boundaryIds, owner, stabilizationMilestone }) => ({
        id,
        level,
        invariantIds,
        boundaryIds,
        owner,
        stabilizationMilestone,
      }),
    ),
    staticChecks: {
      passed: staticChecksPassed,
      findings: staticFindings,
    },
    negativeControls: {
      passed: negativeControlsPassed,
      results: negativeControls,
    },
    unresolvedQuestions: correctnessManifest.unresolvedQuestions,
  } as const;

  return {
    report,
    digest: deterministicDigest(report),
  };
}

export function renderQ0Markdown(
  report: Awaited<ReturnType<typeof createQ0Report>>["report"],
  digest: string,
): string {
  const lines = [
    "# Scry System Correctness Q0 Report",
    "",
    `- Milestone: ${report.milestone} / ${report.qualification}`,
    `- Milestone status: ${report.milestoneStatus}`,
    `- Stabilization readiness: ${report.stabilizationReadiness}`,
    `- Manifest version: ${report.manifestVersion}`,
    `- Source HEAD: ${report.sourceHead}`,
    `- Architecture/source digest: ${report.architectureSourceDigest}`,
    `- Schema fingerprint: ${report.schemaFingerprint}`,
    `- Report digest: ${digest}`,
    "",
    "## Counts",
    "",
    `- Machines/entities: ${report.counts.machines}`,
    `- Invariants: ${report.counts.invariants}`,
    `- High-risk boundaries: ${report.counts.boundaries}`,
    `- Timers/leases: ${report.counts.timersAndLeases}`,
    `- Authority domains: ${report.counts.authorityDomains}`,
    `- Legacy overlays: ${report.counts.legacyOverlays}`,
    `- Ownership adjudications: ${report.counts.ownershipAdjudications}`,
    `- Ownership blockers: ${report.counts.ownershipBlockers}`,
    `- P0/P1 risks: ${report.counts.p0Risks}/${report.counts.p1Risks}`,
    "",
    "## Static checks",
    "",
    report.staticChecks.passed ? "PASS — no manifest/source drift findings." : "BLOCKED",
    "",
    ...report.staticChecks.findings.map(
      ({ reasonId, subject, message }) => `- ${reasonId} (${subject}): ${message}`,
    ),
    "## Negative controls",
    "",
    report.negativeControls.passed
      ? "PASS — every deterministic control produced its required reason ID."
      : "BLOCKED",
    "",
    ...report.negativeControls.results.map(
      ({ id, expectedReasonId, passed }) =>
        `- ${passed ? "PASS" : "FAIL"}: ${id} -> ${expectedReasonId}`,
    ),
    "",
    "## Ownership adjudications",
    "",
    ...report.ownershipAdjudications.map(
      ({ concern, classification, finding }) =>
        `- ${concern} (${classification}): ${finding ?? "classified ownership"}`,
    ),
    "",
    "## Source corrections",
    "",
    ...report.sourceCorrections.map(({ subject, resolution }) => `- ${subject}: ${resolution}`),
    "",
    "## Unresolved questions",
    "",
    ...report.unresolvedQuestions.map((question) => `- ${question}`),
    "",
    "This report is an Assurance/architecture artifact. Production services do not import it and it has no runtime admission authority.",
    "",
  ];
  return lines.join("\n");
}

function countBy<T extends Record<K, PropertyKey>, K extends keyof T>(
  values: T[],
  key: K,
): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values.map((value) => String(value[key])))]
      .sort()
      .map((entry) => [entry, values.filter((value) => String(value[key]) === entry).length]),
  );
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
