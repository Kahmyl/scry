import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { stableJson } from "../q0/validator.js";
import { validateQ5EvidenceManifest } from "./q5-evidence.js";

const q0Digest = "7bf1cd5316faae2d572aa1edb89f5a8a094b076c98be846a8860f2efce0f2230";
const q1Digest = "d01fc4984fc4c4aae7ead2be25eb4b0493fc51e8359b2fd2037aec2e47334668";
const q2Digest = "044a4d3506750c60b7f3f802e0a0f57bf1d3e9383dc25786a24c9d98c8da4357";
const q3Digest = "424293abdc31046dac4879a3e7c29bea8bc32e3a600b68317f350f79cdc51112";
const q3OracleDigest = "94d9d95852f91f99f0e610b6ce66dac7fef0f35230d7fbc831acfc68bf2ddf7f";
export const Q5_DETERMINISTIC_GROUPS = [
  "00_real_shaped_bootstrap",
  "01_static_source_gate",
  "02_database_upgrade_pre_state",
  "03_runtime_identity",
  "04_scoped_principal_adversary",
  "05_mcp_contract",
  "06_deterministic_fake_agent_journey",
  "07_mutation_adversary",
  "08_praxis_regression",
  "09_evidence_report_adversary",
  "10_privacy",
  "11_supervisor_residue",
  "12_paid_call_fuse",
] as const;

export async function createM6Report(root: string) {
  const output = path.join(root, "artifacts/system-correctness/m6");
  const processEvidence = JSON.parse(
    await readFile(path.join(output, "q4-process-evidence.json"), "utf8"),
  ) as {
    processDeathMechanism: string;
    processes: Array<Record<string, unknown> & { phase: string; pid: number }>;
  };
  const sourceHead = git(root, ["rev-parse", "HEAD"]);
  const sourceManifest = createHash("sha256").update(sourceHead).update("\0").digest("hex");
  const schemaFingerprint = execFileSync(
    "node",
    [path.join(root, "scripts/schema-fingerprint.mjs")],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const migrationSha256 = createHash("sha256")
    .update(await readFile(path.join(root, "apps/api/migrations/q5-canonical-scope-bootstrap.sql")))
    .digest("hex");
  const q5Manifest = await readJsonOptional(path.join(output, "q5-authoritative-evidence.json"));
  const q5Validation = validateQ5EvidenceManifest(q5Manifest, {
    sourceCommit: sourceHead,
    sourceManifestSha256: sourceManifest,
    schemaFingerprint,
    migrationSha256,
  });
  const q5DurableBinding = await verifyDurableQ5Evidence(q5Validation.manifest, q5Manifest);
  const boundary = (await readJsonOptional(path.join(output, "q5-deterministic-boundary.json"))) as
    Q5DeterministicBoundary | undefined;
  const requiredProcessPhases = [
    "before_consumption",
    "after_consumption",
    "request_initiated",
    "after_external_commit",
    "after_verification",
    "after_settlement",
    "run_finalization",
    "browser_owner",
    "runtime_lease_owner",
    "agent_owner",
    "run_attempt_owner",
    "reconciliation_owner",
    "protected_operation_owner",
  ];
  const processPass =
    processEvidence.processDeathMechanism === "detached OS process group SIGKILL" &&
    requiredProcessPhases.every((phase) =>
      processEvidence.processes.some((process) => process.phase === phase),
    ) &&
    new Set(processEvidence.processes.map(({ pid }) => pid)).size ===
      processEvidence.processes.length &&
    processEvidence.processes
      .filter(({ oracle }) => oracle)
      .every(({ oracle, scry }) => {
        const observed = oracle as { effects?: number; requests?: number };
        const durable = scry as { mutationsConsumed?: number };
        return (
          (observed.effects ?? 0) <= 1 &&
          (observed.requests ?? 0) <= 1 &&
          (durable.mutationsConsumed ?? 0) <= 1
        );
      });
  const q5Pass = q5Validation.pass && q5DurableBinding.verified;
  const externalQualification = {
    q4ProcessSuite: process.env.SCRY_M6_Q4_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
    q5McpAdversarySuite:
      process.env.SCRY_M6_MCP_ADVERSARY_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
    q04PostgresSuite: process.env.SCRY_M6_Q04_POSTGRES_RESULT === "PASS" ? "PASS" : "NOT_ATTESTED",
  } as const;
  const q04Pass =
    externalQualification.q04PostgresSuite === "PASS" &&
    externalQualification.q5McpAdversarySuite === "PASS";
  const q4Pass = processPass && externalQualification.q4ProcessSuite === "PASS";
  const q5BoundaryPass = validateQ5DeterministicBoundary(boundary);
  const q5ProductSafetyPass = q04Pass && q5BoundaryPass;
  const implementationPass = q04Pass && q4Pass && q5BoundaryPass;
  const closurePass = implementationPass && q5Pass;

  const report = {
    reportSchemaVersion: 1,
    qualification: "Q4 + Q5",
    milestone: 6,
    source: {
      head: sourceHead,
      headSubject: git(root, ["show", "-s", "--format=%s", "HEAD"]),
      manifestSha256: sourceManifest,
      schemaFingerprint,
      q5CanonicalScopeBootstrapMigrationSha256: migrationSha256,
      q0Digest,
      q1Digest,
      q2Digest,
      q3Digest,
      q3OracleDigest,
    },
    verdicts: {
      milestone6Implementation: implementationPass ? "PASS" : "FAIL",
      m6ClosureReview: closurePass ? "PASS" : "FAIL",
      q04MechanicalCampaignSafety: q04Pass ? "PASS" : "FAIL",
      q4ProcessLoss: q4Pass ? "PASS" : "BLOCKED",
      q5RepositoryBlindAgent: q5Pass ? "PASS" : "BLOCKED",
      m6ProductGate: closurePass ? "PASS" : "BLOCKED",
      progression: closurePass ? "ELIGIBLE_FOR_MILESTONE_7" : "BLOCKED",
    },
    campaignAuthorization: {
      model:
        "human-owned, exact-scope, local-test qualification authorization; one Run and one possible business mutation",
      durableFields: [
        "project/environment/mission/objective/agent session",
        "purpose/mode/target origin/application identity",
        "owner/release/schema/expiry",
        "Run and mutation limits/counters/disposition",
      ],
      runConsumption:
        "row-locked in the Run insertion transaction; unique campaign Run index plus all-writer database trigger",
      mutationConsumption:
        "row-locked and journaled at the final pre-dispatch capability boundary; idempotent only for the exact operation/mutation identity",
      scope:
        "one immutable prepared scope containing generated Project/environment/issuance identities, then exact Mission, Objective, agent, and canonical environment origin",
      expiry: "checked under the same PostgreSQL row lock as consumption",
      terminalDisposition:
        "success, failure, inconclusive/UNKNOWN, expiry, and revocation never restore consumed allowance",
      rollout:
        "migration first, then API/worker/MCP; old code tolerates nullable new schema, new code requires migrated schema",
    },
    q04: {
      productProofSource:
        "production repositories, Flow/API/MCP admission, execution capabilities, and PostgreSQL constraints/triggers",
      negativeCases: {
        A: "second Run after success refused",
        B: "second Run after failure refused",
        C: "second Run after inconclusive/UNKNOWN refused",
        D: "second business mutation in live Run refused before fixture request",
        E: "new Run after prior UNKNOWN refused",
        F: "concurrent Run race has one winner",
        G: "concurrent mutation race has one winner",
        H: "expired campaign refused",
        I: "wrong Project refused",
        J: "wrong environment refused",
        K: "wrong target origin refused",
      },
      repetitions: { runRaces: 5, expiryRaces: 5, terminalMutationRacesPerDisposition: 5 },
      externalQualification,
    },
    q4: {
      processDeathMechanism: processEvidence.processDeathMechanism,
      processCount: processEvidence.processes.length,
      uniquePidCount: new Set(processEvidence.processes.map(({ pid }) => pid)).size,
      processes: processEvidence.processes,
      killPoints: [
        ["P1", "B4", "before_consumption"],
        ["P2", "B4", "after_consumption"],
        ["P3", "B5", "request_initiated"],
        ["P4", "B6", "after_external_commit"],
        ["P5", "B7/B8", "after_verification"],
        ["P6", "B9/B10", "after_settlement"],
        ["P7", "B11/B12", "after_verification"],
        ["P8", "B13/B14", "run_finalization"],
        ["P9", "B15", "no separate Objective acceptance process boundary"],
        ["P10", "B19", "browser_owner/runtime_lease_owner"],
        ["P11", "B18/B19", "runtime_lease_owner"],
        ["P12", "B18", "agent_owner/run_attempt_owner"],
      ],
      staleOwnersExercised: [
        "Praxis runtime lease",
        "Run/Attempt claim",
        "reconciliation fence",
        "protected-operation fence",
      ],
      reconciliation: "observation-only; uncertain effects were never redispatched",
      lifecycleConvergence:
        "expired owners were replaced or terminalized; expected UNKNOWN/recovery remained fenced",
    },
    q5: {
      qualification: "M6_Q5_VITRACT_PREVIEW_TEST",
      preparedBoundary: {
        required: true,
        qualificationPolicyVersion: "q5-bootstrap-v1",
        sourceCommit: sourceHead,
        sourceManifestSha256: sourceManifest,
        schemaFingerprint,
        migrationSha256,
        semantics:
          "supported bootstrap -> eligible protected pair -> immutable prepared scope -> free validation -> paid attempt fuse",
      },
      deterministicBoundary: {
        status: q5BoundaryPass ? "PASS" : "BLOCKED",
        groups: boundary?.groups ?? {},
      },
      authoritativeEvidence: {
        present: q5Manifest !== undefined,
        valid: q5Pass,
        issues: [
          ...q5Validation.issues,
          ...(q5Validation.pass && !q5DurableBinding.verified ? [q5DurableBinding.reasonCode] : []),
        ],
        durableBinding: q5DurableBinding,
        manifest: q5Validation.manifest,
      },
      agentCompetence: q5Pass ? "PASS" : "BLOCKED",
      agentQualityFinding: q5Pass
        ? null
        : "Repository-blind agent competence remains unproven until the single authorized real Vitract Preview/Test Q5 campaign produces a valid identity-bound evidence manifest.",
      productSafety: q5ProductSafetyPass ? "PASS" : "BLOCKED",
      productSafetyFinding: q5ProductSafetyPass
        ? "Real-shaped canonical bootstrap, deterministic Q5 boundary qualification, and Q04 mechanically enforce one prepared scope, one Run, one mutation, replay refusal, exact scope, and the durable paid-attempt fuse."
        : "Mechanical refusal was not completely attested.",
      parentSemanticCoaching: false,
    },
    mutationAccounting: {
      q5Campaigns: q5Manifest ? 1 : 0,
      authorizedMutations: q5Validation.manifest?.mutation.campaignConsumptions ?? 0,
      externalRequests: q5Validation.manifest?.mutation.externalRequests ?? 0,
      externalEffects: q5Validation.manifest?.mutation.externalEffects ?? 0,
      duplicates: q5Validation.manifest?.mutation.duplicates ?? 0,
      redispatches: q5Validation.manifest?.mutation.redispatches ?? 0,
      q4PerCampaign: processEvidence.processes
        .filter(({ oracle }) => oracle)
        .map(({ phase, oracle, scry }) => ({ phase, oracle, scry })),
    },
    privacyAndCredentials: {
      protectedLeakCount: boundary?.protectedLeakCount ?? 0,
      persistentMcpTokenChanged: false,
      qualificationCredential:
        "durable one-attempt digest-bound Q5 capability; plaintext never persisted",
      transcriptCommitted: false,
    },
    residue: {
      successfulQ5Scope: "terminal campaign/Run/Praxis/agent required; zero unexplained owner",
      q4: "no observing reconciliation or live stale lease; expected recovery_required protected/UNKNOWN rows remain fenced",
      globalHistoricalRowsRequiredZero: false,
    },
    futureGates: {
      Q01: "Milestone 7 dashboard projection",
      Q6: "Milestone 7 public read-only qualification",
      Q7: "REAL Stage 6 Test Mode qualification only after Milestone 7 guarded re-entry",
    },
    productFindings: [],
  };
  const digest = createHash("sha256").update(stableJson(report)).digest("hex");
  return { report, digest };
}

type Q5DeterministicBoundary = {
  schemaVersion?: number;
  qualification?: string;
  verdict?: string;
  readyForOneAuthoritativeQ5?: boolean;
  paidAuthorization?: string;
  authoritativeAttemptsConsumed?: number;
  protectedLeakCount?: number;
  groups?: Record<string, string>;
  evidence?: Record<string, unknown>;
  scope?: {
    deepSeekCalls?: number;
    authoritativeCampaignExecuted?: boolean;
    stage6Executed?: boolean;
    publicLiveAccess?: boolean;
  };
};

export function validateQ5DeterministicBoundary(boundary: Q5DeterministicBoundary | undefined) {
  if (
    boundary?.schemaVersion !== 1 ||
    boundary.qualification !== "M6_Q5_DETERMINISTIC_BOUNDARY" ||
    boundary.verdict !== "NO_KNOWN_PRE_MISSION_Q5_GAPS" ||
    boundary.readyForOneAuthoritativeQ5 !== true ||
    boundary.paidAuthorization !== "UNUSED" ||
    boundary.authoritativeAttemptsConsumed !== 0 ||
    boundary.protectedLeakCount !== 0 ||
    boundary.scope?.deepSeekCalls !== 0 ||
    boundary.scope.authoritativeCampaignExecuted !== false ||
    boundary.scope.stage6Executed !== false ||
    boundary.scope.publicLiveAccess !== false
  )
    return false;
  if (
    JSON.stringify(Object.keys(boundary.groups ?? {})) !== JSON.stringify(Q5_DETERMINISTIC_GROUPS)
  )
    return false;
  return Q5_DETERMINISTIC_GROUPS.every(
    (group) =>
      boundary.groups?.[group] === "PASS" &&
      Array.isArray(boundary.evidence?.[group]) &&
      (boundary.evidence[group] as unknown[]).length > 0,
  );
}

export function renderM6Markdown(report: any, digest: string) {
  return `# Scry system correctness Q4 + Q5 / Milestone 6\n\n- MILESTONE_6_IMPLEMENTATION: **${report.verdicts.milestone6Implementation}**\n- M6_CLOSURE_REVIEW: **${report.verdicts.m6ClosureReview}**\n- Q04_MECHANICAL_CAMPAIGN_SAFETY: **${report.verdicts.q04MechanicalCampaignSafety}**\n- Q4_PROCESS_LOSS: **${report.verdicts.q4ProcessLoss}**\n- Q5_REPOSITORY_BLIND_AGENT: **${report.verdicts.q5RepositoryBlindAgent}**\n- M6_PRODUCT_GATE: **${report.verdicts.m6ProductGate}**\n- PROGRESSION: **${report.verdicts.progression}**\n- report digest: \`${digest}\`\n\n## Campaign authorization\n\n${report.campaignAuthorization.model}. Run consumption is ${report.campaignAuthorization.runConsumption}. Mutation consumption is ${report.campaignAuthorization.mutationConsumption}.\n\n## Process loss\n\n${report.q4.processCount} distinct SIGKILL-owned processes exercised P1-P8 and representative browser/runtime/agent/Attempt/reconciliation/protected owners.\n\n## Repository-blind agent\n\nThe deterministic authoritative-Q5 boundary is **${report.q5.deterministicBoundary.status}**. The paid repository-blind Vitract Preview/Test campaign remains **${report.q5.agentCompetence}** until an identity-bound authoritative evidence manifest is present and valid.\n\n## Scope\n\nThis report does not prove dashboard projection, public-site behavior, or real external Test Mode mutation. Q7 still means the real Stage 6 Test Mode qualification after Milestone 7 guarded re-entry.\n`;
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function readJsonOptional(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyDurableQ5Evidence(
  manifest: ReturnType<typeof validateQ5EvidenceManifest>["manifest"],
  rawManifest: unknown,
) {
  if (!manifest) return { verified: false, reasonCode: "Q5_MANIFEST_NOT_VALIDATED" } as const;
  const apiUrl = process.env.SCRY_M6_Q5_API_URL;
  const serviceToken = process.env.SCRY_SERVICE_TOKEN;
  if (!apiUrl || !serviceToken)
    return { verified: false, reasonCode: "Q5_DURABLE_API_REQUIRED" } as const;
  if (!/^[0-9a-f-]{36}$/.test(manifest.authority.authoritativeAttemptId))
    return { verified: false, reasonCode: "Q5_ATTEMPT_ID_INVALID" } as const;
  const expectedDigest = createHash("sha256").update(stableJson(rawManifest)).digest("hex");
  try {
    const response = await fetch(
      `${apiUrl}/internal/q5-authoritative-attempts/${manifest.authority.authoritativeAttemptId}/evidence-binding`,
      { headers: { authorization: `Bearer ${serviceToken}` } },
    );
    if (!response.ok) throw new Error("Q5_DURABLE_EVIDENCE_API_REFUSED");
    const result = (await response.json()) as {
      state?: string;
      evidenceManifestDigest?: string;
    };
    return result.state === "succeeded" && result.evidenceManifestDigest === expectedDigest
      ? ({ verified: true, reasonCode: "PASS", digest: expectedDigest } as const)
      : ({ verified: false, reasonCode: "Q5_DURABLE_EVIDENCE_MISMATCH" } as const);
  } catch {
    return { verified: false, reasonCode: "Q5_DURABLE_EVIDENCE_UNAVAILABLE" } as const;
  }
}
