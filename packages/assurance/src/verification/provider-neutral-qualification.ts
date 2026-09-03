import type { AgentLabQualification, AgentLabScenarioId } from "../agent-lab/index.js";
import type { AssuranceEvidenceRef } from "../core/types.js";

export type ProviderNeutralDimension =
  | "spa"
  | "ssr"
  | "multi_page"
  | "popup"
  | "iframe"
  | "redirect"
  | "static_document"
  | "dynamically_replaced_document"
  | "same_origin"
  | "authorized_cross_origin"
  | "synchronous_response"
  | "delayed_response"
  | "polling"
  | "provider_query_reconciliation"
  | "idempotent_mutation"
  | "non_idempotent_mutation"
  | "response_owned_identity"
  | "page_observed_identity"
  | "externally_reconciled_identity"
  | "authentication"
  | "credential_creation"
  | "upload"
  | "download"
  | "destructive_change"
  | "read_only_retrieval"
  | "success"
  | "validation_failure"
  | "permission_denial"
  | "rate_limit"
  | "timeout"
  | "disconnect"
  | "ambiguous_completion"
  | "chromium_runtime_variation"
  | "accessibility_reference_quality_variation";

export const requiredProviderNeutralDimensions: readonly ProviderNeutralDimension[] = [
  "spa",
  "ssr",
  "multi_page",
  "popup",
  "iframe",
  "redirect",
  "static_document",
  "dynamically_replaced_document",
  "same_origin",
  "authorized_cross_origin",
  "synchronous_response",
  "delayed_response",
  "polling",
  "provider_query_reconciliation",
  "idempotent_mutation",
  "non_idempotent_mutation",
  "response_owned_identity",
  "page_observed_identity",
  "externally_reconciled_identity",
  "authentication",
  "credential_creation",
  "upload",
  "download",
  "destructive_change",
  "read_only_retrieval",
  "success",
  "validation_failure",
  "permission_denial",
  "rate_limit",
  "timeout",
  "disconnect",
  "ambiguous_completion",
  "chromium_runtime_variation",
  "accessibility_reference_quality_variation",
] as const;

export type ProviderNeutralMutationTruth =
  "not_applicable" | "not_applied" | "applied" | "unknown" | "preserve_authoritative_result";

export type ProviderNeutralPrivacyBehavior =
  | "public_facts_only"
  | "protected_values_suppressed"
  | "metadata_only"
  | "no_response_body_or_credentials"
  | "veil_safe_boundary_required";

export type ProviderNeutralRecoverySemantics =
  | "no_retry_needed"
  | "safe_after_correction"
  | "reobserve_before_retry"
  | "read_only_repeatable"
  | "reconcile_before_retry"
  | "do_not_retry"
  | "external_agent_decides_from_facts";

export type ProviderNeutralAuthorityOwner =
  | "external_agent"
  | "praxis"
  | "veil"
  | "chronicle"
  | "protected_operation_state_machine"
  | "application_persistence";

export type ProviderNeutralProofTier =
  "deterministic_local" | "production_shaped_local" | "local_campaign" | "public_optional";

export interface ProviderNeutralProofReference {
  tier: ProviderNeutralProofTier;
  path: string;
  contains: string;
  releaseOracle: boolean;
}

export type ProviderNeutralAgentLabParticipation =
  | Readonly<{ kind: "not_relevant"; scenarios: readonly [] }>
  | Readonly<{
      kind: "deepseek_representative";
      scenarios: readonly AgentLabScenarioId[];
    }>;

export interface ProviderNeutralCharacteristicCase {
  id: string;
  title: string;
  dimensions: readonly ProviderNeutralDimension[];
  scenario: string;
  fixture: string;
  expectedMutationTruth: ProviderNeutralMutationTruth;
  expectedEvidence: readonly string[];
  privacyBehavior: ProviderNeutralPrivacyBehavior;
  recoverySemantics: ProviderNeutralRecoverySemantics;
  authoritativeOwner: ProviderNeutralAuthorityOwner;
  agentLab: ProviderNeutralAgentLabParticipation;
  proofs: readonly ProviderNeutralProofReference[];
  requiredForCore: boolean;
}

export const providerAdapterQualificationBoundary = {
  maySupplyFactualReconciliationEvidence: true,
  mayInspectScryProtectedPersistence: false,
  mayChooseSemanticTargets: false,
  mayChooseMissionProgression: false,
  mayWeakenUnknownMutationTruth: false,
} as const;

function proof(
  tier: ProviderNeutralProofTier,
  path: string,
  contains: string,
  releaseOracle = true,
): ProviderNeutralProofReference {
  return { tier, path, contains, releaseOracle };
}

function noAgentLab(): ProviderNeutralAgentLabParticipation {
  return { kind: "not_relevant", scenarios: [] };
}

function deepSeek(...scenarios: AgentLabScenarioId[]): ProviderNeutralAgentLabParticipation {
  return { kind: "deepseek_representative", scenarios };
}

/** Characteristic cases map current proof before introducing any new fixture. */
export const providerNeutralCharacteristicMatrix: readonly ProviderNeutralCharacteristicCase[] = [
  {
    id: "spa_dynamic_replacement",
    title: "SPA dynamic document replacement",
    dimensions: [
      "spa",
      "dynamically_replaced_document",
      "same_origin",
      "page_observed_identity",
      "success",
    ],
    scenario: "A client-rendered surface replaces a semantically stable control before dispatch.",
    fixture: "Existing production-shaped HTTP grounding cohort B, scenario 049.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: [
      "fresh page observation",
      "old exact reference invalidation",
      "new exact reference identity",
    ],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "reobserve_before_retry",
    authoritativeOwner: "external_agent",
    agentLab: deepSeek("exact_references"),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/capability-grounding-http-cohort-b.test.ts",
        "049 re-resolves a semantically stable target after SPA replacement",
      ),
      proof(
        "deterministic_local",
        "packages/assurance/test/praxis-reference-replacement.test.ts",
        "Praxis pinned reference against the reference-replacement fixture",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "ssr_static_retrieval",
    title: "Server-rendered static retrieval",
    dimensions: ["ssr", "static_document", "same_origin", "read_only_retrieval", "success"],
    scenario: "A server-rendered HTML page is observed without an external mutation.",
    fixture: "Existing 34-scenario real-HTTP grounding cohort A.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: [
      "HTTP document response",
      "bounded semantic context",
      "zero mutation dispatch",
    ],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "read_only_repeatable",
    authoritativeOwner: "praxis",
    agentLab: deepSeek("readiness"),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/capability-grounding-real-http-cohort-a.test.ts",
        "cohort A: 34 real-HTTP capability-grounding scenarios",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "multi_page_redirect",
    title: "Multi-page redirect navigation",
    dimensions: ["multi_page", "redirect", "static_document", "same_origin", "success"],
    scenario: "A navigation follows intermediate redirects to the final same-origin document.",
    fixture: "Existing production-shaped HTTP grounding cohort B, scenario 066.",
    expectedMutationTruth: "not_applicable",
    expectedEvidence: ["navigation lineage", "final URL", "new document authority"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/capability-grounding-http-cohort-b.test.ts",
        "066 follows intermediate redirects to the final portal",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "popup_success",
    title: "Authorized popup adoption",
    dimensions: ["popup", "multi_page", "same_origin", "success"],
    scenario: "One expected popup opens at the authorized origin and becomes the active document.",
    fixture: "Existing persistent authoring-browser session popup fixture.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["one new page", "allowed origin", "incremented document epoch"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/authoring-browser-session.test.ts",
        "open-documentation-popup",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "popup_ambiguity",
    title: "Ambiguous popup completion",
    dimensions: ["popup", "multi_page", "ambiguous_completion"],
    scenario: "One action opens multiple candidate pages and Praxis refuses to choose one.",
    fixture: "Existing authoring-browser multiple-page fixture.",
    expectedMutationTruth: "unknown",
    expectedEvidence: ["multiple observed pages", "typed ambiguity reason", "page cleanup facts"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "reconcile_before_retry",
    authoritativeOwner: "praxis",
    agentLab: deepSeek("unknown_recovery"),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/authoring-browser-session.test.ts",
        "EXPECTED_NEW_PAGE_AMBIGUOUS",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "same_origin_iframe",
    title: "Same-origin iframe exact reference",
    dimensions: ["iframe", "same_origin", "success"],
    scenario: "Praxis dispatches once to the pinned entity in a same-origin iframe.",
    fixture: "Existing Praxis target-reference browser fixture.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["frame document identity", "exact element handle", "single dispatch"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/praxis/test/target-reference.test.ts",
        "pins a same-origin iframe target and dispatches a click exactly once",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "authorized_cross_origin_iframe",
    title: "Authorized cross-origin iframe exact reference",
    dimensions: ["iframe", "authorized_cross_origin", "success"],
    scenario: "Praxis dispatches once to a pinned entity in an authorized cross-origin frame.",
    fixture: "Existing two-origin Praxis target-reference fixture.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["allowed frame origin", "frame-local exact reference", "single dispatch"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/praxis/test/target-reference.test.ts",
        "dispatches once for a target inside a cross-origin iframe",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "authorized_cross_origin_redirect",
    title: "Authorized cross-origin response redirect",
    dimensions: ["redirect", "authorized_cross_origin", "synchronous_response", "success"],
    scenario: "An owned request follows an explicitly allowed cross-origin redirect lineage.",
    fixture: "Existing protected-response envelope redirect fixture.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: ["root request identity", "redirect descendants", "allowed final origin"],
    privacyBehavior: "no_response_body_or_credentials",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/executor/test/protected-response-envelope.test.ts",
        "allows an explicitly allowed cross-origin redirect lineage",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "synchronous_response_identity",
    title: "Synchronous response-owned identity",
    dimensions: [
      "synchronous_response",
      "non_idempotent_mutation",
      "response_owned_identity",
      "success",
    ],
    scenario:
      "A one-way mutation returns a public identity bound atomically to the protected operation.",
    fixture: "Existing response-envelope and protected-output persistence tests.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["owned response", "public identity reference", "atomic binding"],
    privacyBehavior: "protected_values_suppressed",
    recoverySemantics: "do_not_retry",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: deepSeek("dispatch", "evidence_selection"),
    proofs: [
      proof(
        "deterministic_local",
        "packages/executor/test/protected-response-envelope.test.ts",
        "stages exactly once after final aggregate analysis for one owned root",
      ),
      proof(
        "deterministic_local",
        "apps/api/test/protected-output-persistence.repository.test.ts",
        "binds a response-provided project public identity in the same transaction",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "delayed_owned_response",
    title: "Delayed owned response",
    dimensions: ["delayed_response", "non_idempotent_mutation", "success"],
    scenario: "A uniquely owned initiated request settles after a bounded delay.",
    fixture: "Existing protected-response envelope delayed-lifecycle fixture.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: [
      "owned request initiation",
      "bounded settlement",
      "eligible response selection",
    ],
    privacyBehavior: "no_response_body_or_credentials",
    recoverySemantics: "do_not_retry",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/executor/test/protected-response-envelope.test.ts",
        "waits for a uniquely owned initiated request response lifecycle",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "polling_readiness",
    title: "Polling-based readiness",
    dimensions: ["polling", "read_only_retrieval", "success"],
    scenario: "Repeated factual observations stop only when exact committed semantics appear.",
    fixture: "Existing successor-checkpoint semantic polling test.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: ["ordered observations", "bounded polling interval", "exact semantic match"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "read_only_repeatable",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "apps/api/test/successor-checkpoint-semantic.test.ts",
        "waits through transient pre-hydration semantics until the exact committed context appears",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "provider_query_reconciliation",
    title: "Provider-query reconciliation",
    dimensions: [
      "provider_query_reconciliation",
      "externally_reconciled_identity",
      "ambiguous_completion",
    ],
    scenario:
      "A factual adapter reconciles an unknown effect only with complete durable correlation.",
    fixture: "Existing provider-neutral reconciliation registry tests.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: [
      "exact resource identity",
      "provider fact",
      "local correlation completeness",
    ],
    privacyBehavior: "metadata_only",
    recoverySemantics: "reconcile_before_retry",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: deepSeek("unknown_recovery"),
    proofs: [
      proof(
        "deterministic_local",
        "apps/api/test/adaptive-operation-reconciliation.registry.test.ts",
        "requires exactly one provider supporting the complete durable correlation",
      ),
      proof(
        "deterministic_local",
        "apps/api/test/adaptive-operation-reconciliation.registry.test.ts",
        "does not observe for ownership mismatch or ambiguous provider authority",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "idempotent_mutation",
    title: "Idempotent mutation identity",
    dimensions: ["idempotent_mutation", "success"],
    scenario:
      "A consumer operation derives one stable transaction identity for safe replay semantics.",
    fixture: "Existing Praxis consumer idempotency test.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: [
      "stable transaction identity",
      "same operation identity",
      "single dispatch boundary",
    ],
    privacyBehavior: "metadata_only",
    recoverySemantics: "external_agent_decides_from_facts",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/praxis/test/runtime.test.ts",
        "derives an idempotent transaction identity for a consumer operation",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "page_observed_identity",
    title: "Page-observed identity",
    dimensions: ["page_observed_identity", "success"],
    scenario:
      "A newly visible public record is accepted only with issuance-bound identity evidence.",
    fixture: "Existing external-record identity characterization.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: ["before/after public facts", "issuance binding", "exact record identity"],
    privacyBehavior: "protected_values_suppressed",
    recoverySemantics: "do_not_retry",
    authoritativeOwner: "praxis",
    agentLab: deepSeek("evidence_selection"),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/praxis/test/external-record-identity-binding.characterization.test.ts",
        "proves one record only from an issuance-bound public record ID",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "authentication_success",
    title: "Protected authentication",
    dimensions: ["authentication", "success"],
    scenario: "Protected fields and one exact submit execute inside a Veil-owned interval.",
    fixture: "Existing authoring-browser protected-authentication fixture.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["exact protected references", "authenticated state", "privacy result"],
    privacyBehavior: "veil_safe_boundary_required",
    recoverySemantics: "no_retry_needed",
    authoritativeOwner: "veil",
    agentLab: deepSeek("protected_authorization", "dispatch"),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/executor/test/authoring-browser-session.test.ts",
        "composes exact protected fields and submit inside one Veil interval",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "credential_creation",
    title: "Credential creation and protected persistence",
    dimensions: [
      "credential_creation",
      "non_idempotent_mutation",
      "response_owned_identity",
      "success",
    ],
    scenario:
      "A generated credential is encrypted and only safe metadata plus references are returned.",
    fixture: "Existing project-credential repository tests.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["encrypted persistence", "credential reference", "agent provenance"],
    privacyBehavior: "protected_values_suppressed",
    recoverySemantics: "do_not_retry",
    authoritativeOwner: "application_persistence",
    agentLab: deepSeek("protected_authorization", "dispatch", "evidence_selection"),
    proofs: [
      proof(
        "deterministic_local",
        "apps/api/test/repository-credential.test.ts",
        "encrypts the supplied value and returns metadata only",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "unsupported_file_upload",
    title: "Unsupported file-upload mutation",
    dimensions: ["upload", "validation_failure"],
    scenario:
      "A file-upload mutation is absent from the generic action contract and cannot dispatch through an ad hoc provider path.",
    fixture: "Deterministic canonical-action rejection; no application fixture is needed.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: [
      "canonical action rejection",
      "zero upload dispatch",
      "explicit capability absence",
    ],
    privacyBehavior: "protected_values_suppressed",
    recoverySemantics: "external_agent_decides_from_facts",
    authoritativeOwner: "external_agent",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/assurance/test/provider-neutral-qualification.test.ts",
        "keeps unsupported file upload outside generic mutation architecture",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "exact_download",
    title: "Exact-reference download",
    dimensions: ["download", "success"],
    scenario: "A download begins only from the exact pinned activation entity.",
    fixture: "Existing Praxis target-reference download fixture.",
    expectedMutationTruth: "applied",
    expectedEvidence: ["pinned activation reference", "download object", "suggested filename"],
    privacyBehavior: "veil_safe_boundary_required",
    recoverySemantics: "reobserve_before_retry",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/praxis/test/target-reference.test.ts",
        "downloads only through the exact pinned activation entity",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "destructive_change",
    title: "Destructive external-resource change",
    dimensions: ["destructive_change", "permission_denial"],
    scenario:
      "A destructive intent requires exact binding and trusted authority before observation or dispatch.",
    fixture: "Existing external-resource destructive preparation tests.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: ["resource binding", "trusted authority", "zero unauthorized observation"],
    privacyBehavior: "metadata_only",
    recoverySemantics: "safe_after_correction",
    authoritativeOwner: "external_agent",
    agentLab: deepSeek("protected_authorization"),
    proofs: [
      proof(
        "deterministic_local",
        "apps/api/test/external-resource-destructive-target-preparation.service.test.ts",
        "resolves binding and trusted authority before invoking any observation",
      ),
      proof(
        "deterministic_local",
        "packages/praxis/test/risk-policy.test.ts",
        "requires strongest evidence for destructive and protected interactions",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "read_only_status_matrix",
    title: "Read-only response status matrix",
    dimensions: [
      "read_only_retrieval",
      "success",
      "validation_failure",
      "permission_denial",
      "rate_limit",
    ],
    scenario:
      "A GET operation classifies success and documented refusal statuses without mutation authority.",
    fixture: "Existing local protected-transaction status matrix for 200/400/401/403/404/422/429.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: ["one GET dispatch", "status class", "response ownership facts"],
    privacyBehavior: "no_response_body_or_credentials",
    recoverySemantics: "read_only_repeatable",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: deepSeek("readiness"),
    proofs: [
      proof(
        "production_shaped_local",
        "apps/api/test/protected-transaction-coordinator.test.ts",
        "settles documented read-only request status %s through the production kernel",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "pre_dispatch_timeout",
    title: "Pre-dispatch timeout",
    dimensions: ["timeout", "validation_failure"],
    scenario:
      "The total transaction deadline expires before dispatch and mutation remains not applied.",
    fixture: "Existing Praxis transaction deadline tests.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: ["deadline", "zero dispatch", "typed timeout reason"],
    privacyBehavior: "metadata_only",
    recoverySemantics: "safe_after_correction",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "deterministic_local",
        "packages/praxis/test/transaction.test.ts",
        "maps the total transaction timeout without dispatch",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "browser_disconnect",
    title: "Browser runtime disconnect",
    dimensions: ["disconnect", "ambiguous_completion"],
    scenario:
      "The retained browser session disconnects and the runtime crashes without automatic redispatch.",
    fixture: "Existing authoring-runtime ownership failure test.",
    expectedMutationTruth: "unknown",
    expectedEvidence: ["runtime lease", "disconnect reason", "terminal command result"],
    privacyBehavior: "metadata_only",
    recoverySemantics: "reconcile_before_retry",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: deepSeek("unknown_recovery"),
    proofs: [
      proof(
        "deterministic_local",
        "apps/api/test/authoring-runtime-owner.test.ts",
        "fails the command and crashes the runtime after a session failure",
      ),
      proof(
        "deterministic_local",
        "apps/api/test/authoring-runtime-owner.test.ts",
        "treats unknown mutation state as terminal and never retries the operation",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "response_timeout_ambiguity",
    title: "Post-dispatch response timeout",
    dimensions: ["timeout", "ambiguous_completion", "non_idempotent_mutation"],
    scenario: "An owned response arrives after settlement expiry and cannot authorize redispatch.",
    fixture: "Existing protected-response late-result fixture.",
    expectedMutationTruth: "unknown",
    expectedEvidence: ["dispatch started", "settlement expiry", "late result discarded"],
    privacyBehavior: "no_response_body_or_credentials",
    recoverySemantics: "reconcile_before_retry",
    authoritativeOwner: "protected_operation_state_machine",
    agentLab: deepSeek("unknown_recovery"),
    proofs: [
      proof(
        "deterministic_local",
        "packages/executor/test/protected-response-envelope.test.ts",
        "discards a late owned body after settlement expiry and never stages",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "chromium_runtime_variation",
    title: "Chromium runtime qualification",
    dimensions: ["chromium_runtime_variation", "success"],
    scenario:
      "Self-contained observer/privacy artifacts execute in the configured production browser channel.",
    fixture:
      "Existing browser-runtime artifact health gate and Chromium redirect characterization.",
    expectedMutationTruth: "not_applicable",
    expectedEvidence: ["runtime health", "browser channel", "real Chromium lifecycle"],
    privacyBehavior: "protected_values_suppressed",
    recoverySemantics: "safe_after_correction",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "production_shaped_local",
        "packages/praxis/test/browser-runtime-artifacts.test.ts",
        "executes observer and privacy artifacts in the production browser boundary",
      ),
      proof(
        "production_shaped_local",
        "packages/executor/test/protected-response-redirect-lifecycle.characterization.test.ts",
        "records real Chromium redirect event ordering over repeated natural redirects",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "accessibility_reference_quality",
    title: "Accessibility and reference-quality variation",
    dimensions: ["accessibility_reference_quality_variation", "validation_failure", "success"],
    scenario:
      "Malformed and non-native controls retain functional truth while quality findings stay distinct.",
    fixture: "Existing Praxis malformed-control corpus and grounding gauntlet.",
    expectedMutationTruth: "preserve_authoritative_result",
    expectedEvidence: [
      "accessibility facts",
      "exact reference quality",
      "non-blocking quality findings",
    ],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "external_agent_decides_from_facts",
    authoritativeOwner: "external_agent",
    agentLab: deepSeek("exact_references"),
    proofs: [
      proof(
        "deterministic_local",
        "packages/praxis/test/malformed-control-corpus.test.ts",
        "separates functional success from quality findings",
      ),
      proof(
        "production_shaped_local",
        "packages/executor/test/capability-grounding-gauntlet.test.ts",
        "52-scenario capability-grounding browser gauntlet",
      ),
    ],
    requiredForCore: true,
  },
  {
    id: "public_benign_compatibility",
    title: "Optional public benign compatibility cohort",
    dimensions: ["spa", "ssr", "multi_page", "chromium_runtime_variation"],
    scenario: "Read-only inspection/navigation runs across a diverse public-application cohort.",
    fixture: "Existing Praxis public-application campaign; compatibility evidence only.",
    expectedMutationTruth: "not_applied",
    expectedEvidence: ["public final URL", "bounded Praxis result", "browser version"],
    privacyBehavior: "public_facts_only",
    recoverySemantics: "read_only_repeatable",
    authoritativeOwner: "praxis",
    agentLab: noAgentLab(),
    proofs: [
      proof(
        "public_optional",
        "packages/assurance/scripts/campaigns/praxis-public-app-campaign.ts",
        "public application count outside 20-30",
        false,
      ),
    ],
    requiredForCore: false,
  },
] as const;

export interface ProviderNeutralCaseObservation {
  caseId: string;
  mutationTruth?: ProviderNeutralMutationTruth;
  privacyBehavior?: ProviderNeutralPrivacyBehavior;
  recoverySemantics?: ProviderNeutralRecoverySemantics;
  authoritativeOwner?: ProviderNeutralAuthorityOwner;
  evidence: readonly AssuranceEvidenceRef[];
}

export interface ProviderNeutralCaseQualification {
  caseId: string;
  coreStatus: "pass" | "fail" | "inconclusive";
  reasonCodes: readonly string[];
  evidence: readonly AssuranceEvidenceRef[];
  deepSeekStatus: "not_relevant" | "pass" | "fail" | "external_prerequisite";
  deepSeekReasonCodes: readonly string[];
}

export interface ProviderNeutralMatrixAudit {
  status: "pass" | "fail";
  missingDimensions: readonly ProviderNeutralDimension[];
  duplicateCaseIds: readonly string[];
  publicSoleReleaseOracleCases: readonly string[];
  providerNamedCases: readonly string[];
}

export function auditProviderNeutralMatrix(
  matrix: readonly ProviderNeutralCharacteristicCase[],
): ProviderNeutralMatrixAudit {
  const requiredCases = matrix.filter(({ requiredForCore }) => requiredForCore);
  const covered = new Set(requiredCases.flatMap(({ dimensions }) => dimensions));
  const seen = new Set<string>();
  const duplicateCaseIds = new Set<string>();
  for (const { id } of matrix) {
    if (seen.has(id)) duplicateCaseIds.add(id);
    seen.add(id);
  }
  const publicSoleReleaseOracleCases = requiredCases
    .filter(
      ({ proofs }) =>
        proofs.length === 0 ||
        proofs.every(({ tier, releaseOracle }) => tier === "public_optional" || !releaseOracle),
    )
    .map(({ id }) => id);
  const providerNamedCases = matrix
    .filter(({ id, title, scenario, fixture }) =>
      /vitract|qwen|ollama/i.test([id, title, scenario, fixture].join(" ")),
    )
    .map(({ id }) => id);
  const missingDimensions = requiredProviderNeutralDimensions.filter(
    (dimension) => !covered.has(dimension),
  );
  return {
    status:
      missingDimensions.length ||
      duplicateCaseIds.size ||
      publicSoleReleaseOracleCases.length ||
      providerNamedCases.length
        ? "fail"
        : "pass",
    missingDimensions,
    duplicateCaseIds: [...duplicateCaseIds],
    publicSoleReleaseOracleCases,
    providerNamedCases,
  };
}

export function qualifyProviderNeutralCase(
  characteristic: ProviderNeutralCharacteristicCase,
  observation: ProviderNeutralCaseObservation,
  deepSeekQualification?: AgentLabQualification,
): ProviderNeutralCaseQualification {
  const reasonCodes: string[] = [];
  if (characteristic.id !== observation.caseId) reasonCodes.push("CASE_ID_MISMATCH");
  if (observation.evidence.length === 0) reasonCodes.push("CASE_EVIDENCE_UNAVAILABLE");
  if (observation.mutationTruth === undefined) reasonCodes.push("MUTATION_TRUTH_UNAVAILABLE");
  else if (observation.mutationTruth !== characteristic.expectedMutationTruth)
    reasonCodes.push("MUTATION_TRUTH_MISMATCH");
  if (observation.privacyBehavior === undefined) reasonCodes.push("PRIVACY_EVIDENCE_UNAVAILABLE");
  else if (observation.privacyBehavior !== characteristic.privacyBehavior)
    reasonCodes.push("PRIVACY_BEHAVIOR_MISMATCH");
  if (observation.recoverySemantics === undefined)
    reasonCodes.push("RECOVERY_EVIDENCE_UNAVAILABLE");
  else if (observation.recoverySemantics !== characteristic.recoverySemantics)
    reasonCodes.push("RECOVERY_SEMANTICS_MISMATCH");
  if (observation.authoritativeOwner === undefined)
    reasonCodes.push("AUTHORITY_EVIDENCE_UNAVAILABLE");
  else if (observation.authoritativeOwner !== characteristic.authoritativeOwner)
    reasonCodes.push("AUTHORITATIVE_OWNER_MISMATCH");
  if (
    observation.mutationTruth === "unknown" &&
    !["reconcile_before_retry", "do_not_retry"].includes(observation.recoverySemantics ?? "")
  )
    reasonCodes.push("UNKNOWN_MUTATION_RETRY_UNSAFE");

  const unavailable = reasonCodes.some((code) => code.endsWith("_UNAVAILABLE"));
  const deepSeek = qualifyDeepSeek(characteristic.agentLab, deepSeekQualification);
  return {
    caseId: characteristic.id,
    coreStatus: reasonCodes.length === 0 ? "pass" : unavailable ? "inconclusive" : "fail",
    reasonCodes,
    evidence: [...observation.evidence],
    ...deepSeek,
  };
}

function qualifyDeepSeek(
  participation: ProviderNeutralAgentLabParticipation,
  qualification?: AgentLabQualification,
): Pick<ProviderNeutralCaseQualification, "deepSeekStatus" | "deepSeekReasonCodes"> {
  if (participation.kind === "not_relevant")
    return { deepSeekStatus: "not_relevant", deepSeekReasonCodes: [] };
  if (!qualification)
    return {
      deepSeekStatus: "external_prerequisite",
      deepSeekReasonCodes: ["DEEPSEEK_AGENT_LAB_UNAVAILABLE"],
    };
  if (qualification.cohort !== "deepseek")
    return { deepSeekStatus: "fail", deepSeekReasonCodes: ["NON_DEEPSEEK_COHORT_REJECTED"] };
  if (qualification.status !== "PASS")
    return {
      deepSeekStatus:
        qualification.status === "PARTIAL_EXTERNAL_PREREQUISITE" ? "external_prerequisite" : "fail",
      deepSeekReasonCodes: qualification.failures.length
        ? qualification.failures
        : [qualification.externalPrerequisite ?? "DEEPSEEK_AGENT_LAB_INCOMPLETE"],
    };
  const completed = new Set(qualification.scenarioRuns.map(({ scenarioId }) => scenarioId));
  const missing = participation.scenarios.filter((scenario) => !completed.has(scenario));
  return missing.length
    ? {
        deepSeekStatus: "fail",
        deepSeekReasonCodes: missing.map((scenario) => `DEEPSEEK_SCENARIO_MISSING:${scenario}`),
      }
    : { deepSeekStatus: "pass", deepSeekReasonCodes: [] };
}
