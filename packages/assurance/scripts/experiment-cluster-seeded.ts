import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defineSeededSiblingExperimentCluster,
  normalizeExperimentClusterEvidence,
  seededSiblingRemediationProposal,
  synthesizeExperimentCluster,
} from "../src/index.js";

const artifactRootArgument = process.argv[2];

if (!artifactRootArgument) {
  throw new Error("Usage: experiment-cluster-seeded <new-artifact-directory>");
}

const artifactRoot = path.resolve(artifactRootArgument);

await mkdir(path.dirname(artifactRoot), { recursive: true });
await mkdir(artifactRoot, { recursive: false, mode: 0o700 });

const cluster = defineSeededSiblingExperimentCluster();
const evidenceBundle = normalizeExperimentClusterEvidence(cluster);
const synthesis = synthesizeExperimentCluster(cluster, seededSiblingRemediationProposal());

await Promise.all([
  writeImmutable(path.join(artifactRoot, "cluster.json"), prettyJson(cluster)),
  writeImmutable(path.join(artifactRoot, "evidence-bundle.json"), prettyJson(evidenceBundle)),
  writeImmutable(path.join(artifactRoot, "synthesis.json"), prettyJson(synthesis)),
  writeImmutable(path.join(artifactRoot, "report.md"), renderReport(synthesis)),
]);

process.stdout.write(
  `${JSON.stringify(
    {
      clusterId: synthesis.clusterId,
      evidenceBundleDigest: synthesis.evidenceBundleDigest,
      recommendedOptionId: synthesis.proposal.recommendedOptionId,
      candidatePatchDispositions: synthesis.proposal.options.subsystem.candidatePatchDispositions,
      authorizationRequired: synthesis.authorizationRequired,
      executionAuthority: synthesis.executionAuthority,
      prohibitedActions: synthesis.prohibitedActions,
      artifactRoot,
    },
    null,
    2,
  )}\n`,
);

async function writeImmutable(target: string, content: string): Promise<void> {
  await writeFile(target, content, { flag: "wx", mode: 0o444 });
  await chmod(target, 0o444);
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderReport(synthesis: ReturnType<typeof synthesizeExperimentCluster>): string {
  const proposal = synthesis.proposal;
  const recommended = Object.values(proposal.options).find(
    ({ optionId }) => optionId === proposal.recommendedOptionId,
  );

  return `# Sibling-experiment remediation synthesis

- Cluster: ${synthesis.clusterId}
- Evidence bundle: ${synthesis.evidenceBundleDigest}
- Recommended option: ${proposal.recommendedOptionId}
- Recommended scope: ${recommended?.scope ?? "unknown"}
- Human authorization required: ${synthesis.authorizationRequired}
- Execution authority: ${synthesis.executionAuthority}
- Prohibited actions: ${synthesis.prohibitedActions.join(", ")}

## Shared root cause

${proposal.sharedRootCauses.map((finding) => `- ${finding.statement} [${finding.evidenceIds.join(", ")}]`).join("\n")}

## Distinct root causes

${proposal.distinctRootCauses.map((finding) => `- ${finding.statement} [${finding.evidenceIds.join(", ")}]`).join("\n")}

## Candidate patch disposition

${recommended?.candidatePatchDispositions.map((item) => `- ${item.experimentId}: ${item.disposition} — ${item.reason}`).join("\n") ?? "- No recommended option."}

## Uncertainty

${proposal.uncertainties.map((item) => `- ${item.statement} Missing: ${item.missingEvidence.join(", ")}.`).join("\n")}
`;
}
