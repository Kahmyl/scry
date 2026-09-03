import { createHash } from "node:crypto";
import { SensitiveValueClassifier } from "./classifier.js";

export const protectionSinks = [
  "agent_observation",
  "mcp_response",
  "database_safe_field",
  "event",
  "report",
  "recording",
  "screenshot",
  "replay",
] as const;

export type ProtectionSink = (typeof protectionSinks)[number];
export type ProtectionLabel = "quarantined" | "protected" | "public";
export type ProtectionPath = readonly (string | number)[];

export interface ProtectionScope {
  projectId: string;
  missionId: string;
  runId: string;
  sessionId: string;
  origin: string;
}

export type DisclosureMode = "confidential" | "trusted_application_output";

export interface RestoredPublicValue {
  value: string;
  allowedSinks: readonly ProtectionSink[];
}

export interface AdmittedFieldEvidence {
  semantic: string;
  path: ProtectionPath;
  source: "environment_disclosure_policy";
  sourceDigest: string;
  captureId: string;
  captureDigest: string;
  contentClass: "http_json" | "dom_region";
  admissionMode: "trusted_application_output";
  origin: string;
  observedAt: string;
  revision: number;
}

export interface ProtectionCandidate {
  path: ProtectionPath;
  value: string | number | boolean | null;
  semanticHint?: string;
  protectedLineage?: boolean;
}

export interface ProtectionProposal {
  key: string;
  semantic?: string;
  path: ProtectionPath;
  classification: "public" | "protected";
  evidence?: AdmittedFieldEvidence;
}

export interface ProtectionBarrierToken {
  effectId: string;
  decisionRevision: number;
  scopeDigest: string;
}

export interface ProtectionDecision {
  captureId: string;
  effectId: string;
  key: string;
  path: ProtectionPath;
  label: Exclude<ProtectionLabel, "quarantined">;
  allowedSinks: readonly ProtectionSink[];
  valueDigest: string;
  decisionRevision: number;
  decisionDigest: string;
  reason: string;
  publicAdmissionMode?: "trusted_application_output";
  publicSemantic?: string;
  publicEvidenceDigest?: string;
  publicProposalDigest?: string;
}

interface SettledCapture {
  settlementDigest: string;
  decisions: readonly ProtectionDecision[];
}

const MASK = "[PROTECTED]";
const QUARANTINED = "[QUARANTINED]";
const PUBLIC_SINKS: readonly ProtectionSink[] = [
  "agent_observation",
  "mcp_response",
  "database_safe_field",
  "event",
  "report",
  "recording",
  "screenshot",
  "replay",
];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathIdentity(value: ProtectionPath): string {
  return JSON.stringify(value);
}

function scalarText(value: ProtectionCandidate["value"]): string {
  return value === null ? "null" : String(value);
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("protection_evidence_digest_invalid");
}

function assertObservedAt(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("protection_evidence_time_invalid");
}

function normalizedSemantic(parts: readonly string[]): string {
  return parts
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase();
}

function requiresProtection(candidate: ProtectionCandidate, proposalKey: string): boolean {
  const semantic = normalizedSemantic([
    proposalKey,
    ...candidate.path.filter((part): part is string => typeof part === "string"),
    candidate.semanticHint ?? "",
  ]);
  return (
    /\b(secret|password|passwd|passphrase|token|bearer|private|protected|sensitive)\b/u.test(
      semantic,
    ) ||
    /\b(api|access|client|signing|encryption|session)\s+(key|secret|token)\b/u.test(semantic) ||
    /\b(recovery|activation|verification|one\s+time)\s+(code|key|token)\b/u.test(semantic) ||
    /\b(otp|pin)\b/u.test(semantic)
  );
}

function isDetectedSensitive(candidate: ProtectionCandidate): boolean {
  if (requiresProtection(candidate, "")) return true;
  if (typeof candidate.value !== "string" || candidate.value.length === 0) return false;
  return new SensitiveValueClassifier().findings(candidate.value).length > 0;
}

function isHighConfidenceSensitive(candidate: ProtectionCandidate): boolean {
  if (requiresProtection(candidate, "")) return true;
  if (typeof candidate.value !== "string" || candidate.value.length === 0) return false;
  // Entropy alone is deliberately a conservative quarantine signal for
  // unselected values, but it cannot distinguish opaque resource identifiers
  // from secrets. Exact secret/PII patterns remain a declassification veto.
  return new SensitiveValueClassifier()
    .findings(candidate.value)
    .some((finding) => finding.category !== "high-entropy");
}

/**
 * The sole authority for releasing captured values to safe/public sinks.
 * Detectors and callers provide evidence or proposals; neither can publish a value.
 */
export class ProtectionAuthority {
  readonly #scope: ProtectionScope;
  readonly #scopeDigest: string;
  readonly #disclosureMode: DisclosureMode;
  readonly #activeBarriers = new Map<string, ProtectionBarrierToken>();
  readonly #settledCaptures = new Map<string, SettledCapture>();
  readonly #protectedValues = new Map<string, string>();
  readonly #publicValues: Array<{ value: string; allowedSinks: readonly ProtectionSink[] }> = [];
  #decisionRevision = 0;

  constructor(options: {
    scope: ProtectionScope;
    disclosureMode?: DisclosureMode;
    protectedValues?: Readonly<Record<string, string>>;
    restoredPublicValues?: readonly RestoredPublicValue[];
  }) {
    this.#scope = structuredClone(options.scope);
    this.#scopeDigest = digest(this.#scope);
    this.#disclosureMode = options.disclosureMode ?? "confidential";
    this.restoreProtectedValues(options.protectedValues ?? {});
    this.restorePublicValues(options.restoredPublicValues ?? []);
  }

  restoreProtectedValues(values: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(values)) {
      if (value.length === 0) continue;
      this.#protectedValues.set(name, value);
      for (let index = this.#publicValues.length - 1; index >= 0; index -= 1)
        if (this.#publicValues[index]?.value === value) this.#publicValues.splice(index, 1);
    }
  }

  restorePublicValues(values: readonly RestoredPublicValue[]): void {
    for (const restored of values) {
      if (
        restored.value.length === 0 ||
        restored.allowedSinks.length === 0 ||
        restored.allowedSinks.some((sink) => !protectionSinks.includes(sink))
      )
        throw new Error("protection_restored_public_value_invalid");
      if ([...this.#protectedValues.values()].includes(restored.value)) continue;
      this.#publicValues.push({
        value: restored.value,
        allowedSinks: [...new Set(restored.allowedSinks)],
      });
    }
  }

  get scopeDigest(): string {
    return this.#scopeDigest;
  }

  get hasActiveBarrier(): boolean {
    return this.#activeBarriers.size > 0;
  }

  begin(effectId: string): ProtectionBarrierToken {
    const existing = this.#activeBarriers.get(effectId);
    if (existing) return structuredClone(existing);
    const token = {
      effectId,
      decisionRevision: ++this.#decisionRevision,
      scopeDigest: this.#scopeDigest,
    };
    this.#activeBarriers.set(effectId, token);
    return structuredClone(token);
  }

  resume(token: ProtectionBarrierToken): void {
    if (token.scopeDigest !== this.#scopeDigest)
      throw new Error("protection_barrier_scope_mismatch");
    const current = this.#activeBarriers.get(token.effectId);
    if (current) {
      if (
        current.scopeDigest !== token.scopeDigest ||
        current.decisionRevision !== token.decisionRevision
      )
        throw new Error("protection_barrier_token_stale");
      return;
    }
    this.#decisionRevision = Math.max(this.#decisionRevision, token.decisionRevision);
    this.#activeBarriers.set(token.effectId, structuredClone(token));
  }

  publicEvidence(
    token: ProtectionBarrierToken,
    semantic: string,
    fieldPath: ProtectionPath,
    capture: {
      id: string;
      digest: string;
      observedAt: string;
      contentClass: "http_json" | "dom_region";
    },
  ): AdmittedFieldEvidence {
    this.#assertCurrentToken(token);
    if (this.#disclosureMode !== "trusted_application_output")
      throw new Error("protection_public_admission_unavailable");
    assertDigest(capture.digest);
    assertObservedAt(capture.observedAt);
    return {
      semantic,
      path: structuredClone(fieldPath),
      source: "environment_disclosure_policy",
      sourceDigest: digest({
        admissionMode: this.#disclosureMode,
        scopeDigest: this.#scopeDigest,
        captureId: capture.id,
        captureDigest: capture.digest,
        contentClass: capture.contentClass,
        semantic,
        path: fieldPath,
      }),
      captureId: capture.id,
      captureDigest: capture.digest,
      contentClass: capture.contentClass,
      admissionMode: this.#disclosureMode,
      origin: this.#scope.origin,
      observedAt: capture.observedAt,
      revision: token.decisionRevision,
    };
  }

  settle(input: {
    token: ProtectionBarrierToken;
    captureId: string;
    candidates: readonly ProtectionCandidate[];
    proposals: readonly ProtectionProposal[];
  }): readonly ProtectionDecision[] {
    const candidateByPath = new Map(
      input.candidates.map((candidate) => [pathIdentity(candidate.path), candidate] as const),
    );
    if (candidateByPath.size !== input.candidates.length)
      throw new Error("protection_candidate_path_duplicate");
    const proposalByPath = new Map<string, ProtectionProposal>();
    const keys = new Set<string>();
    for (const proposal of input.proposals) {
      if (keys.has(proposal.key)) throw new Error("protection_output_key_duplicate");
      keys.add(proposal.key);
      const identity = pathIdentity(proposal.path);
      if (proposalByPath.has(identity)) throw new Error("protection_output_path_conflict");
      if (!candidateByPath.has(identity)) throw new Error("protection_output_mapping_incomplete");
      proposalByPath.set(identity, proposal);
    }
    const settlementDigest = digest({
      token: input.token,
      captureId: input.captureId,
      candidates: input.candidates.map((candidate) => ({
        path: candidate.path,
        valueDigest: digestText(scalarText(candidate.value)),
        semanticHint: candidate.semanticHint,
        protectedLineage: candidate.protectedLineage ?? false,
      })),
      proposals: input.proposals,
    });
    const existing = this.#settledCaptures.get(input.captureId);
    if (existing) {
      if (existing.settlementDigest !== settlementDigest)
        throw new Error("protection_settlement_conflict");
      return structuredClone(existing.decisions);
    }
    this.#assertCurrentToken(input.token);

    const decisions: ProtectionDecision[] = [];
    for (const candidate of input.candidates) {
      const identity = pathIdentity(candidate.path);
      const proposal = proposalByPath.get(identity);
      const value = scalarText(candidate.value);
      const valueDigest = digestText(value);
      const automaticallyProtected =
        candidate.protectedLineage || this.#isKnownProtected(candidate) || isDetectedSensitive(candidate);
      if (!proposal && !automaticallyProtected) continue;

      let label: ProtectionDecision["label"] = "protected";
      let allowedSinks: readonly ProtectionSink[] = [];
      let reason = proposal ? "caller_selected_protected" : "authority_detected_protected";
      let publicProvenance: Pick<
        ProtectionDecision,
        | "publicAdmissionMode"
        | "publicSemantic"
        | "publicEvidenceDigest"
        | "publicProposalDigest"
      > = {};

      if (proposal?.classification === "public") {
        const semantic = proposal.semantic;
        if (!semantic) throw new Error("protection_public_semantic_missing");
        const evidence = proposal.evidence;
        if (
          candidate.protectedLineage ||
          this.#isKnownProtected(candidate) ||
          requiresProtection(candidate, semantic) ||
          isHighConfidenceSensitive(candidate)
        ) {
          throw new Error("protection_declassification_forbidden");
        }
        if (this.#disclosureMode !== "trusted_application_output")
          throw new Error("protection_public_admission_unavailable");
        if (!evidence) throw new Error("protection_public_evidence_missing");
        assertDigest(evidence.sourceDigest);
        assertObservedAt(evidence.observedAt);
        if (
          evidence.semantic !== semantic ||
          pathIdentity(evidence.path) !== identity ||
          evidence.source !== "environment_disclosure_policy" ||
          evidence.captureId !== input.captureId ||
          !["http_json", "dom_region"].includes(evidence.contentClass) ||
          evidence.admissionMode !== this.#disclosureMode ||
          evidence.sourceDigest !==
            digest({
              admissionMode: this.#disclosureMode,
              scopeDigest: this.#scopeDigest,
              captureId: evidence.captureId,
              captureDigest: evidence.captureDigest,
              contentClass: evidence.contentClass,
              semantic,
              path: evidence.path,
            }) ||
          evidence.origin !== this.#scope.origin ||
          evidence.revision !== input.token.decisionRevision
        )
          throw new Error("protection_public_evidence_mismatch");
        label = "public";
        allowedSinks = PUBLIC_SINKS;
        reason = "environment_policy:trusted_application_output";
        publicProvenance = {
          publicAdmissionMode: this.#disclosureMode,
          publicSemantic: semantic,
          publicEvidenceDigest: evidence.sourceDigest,
          publicProposalDigest: digest({
            key: proposal.key,
            semantic,
            path: proposal.path,
            captureId: input.captureId,
          }),
        };
      }

      if (label === "protected") this.#registerProtected(proposal?.key ?? identity, candidate);
      else this.#publicValues.push({ value, allowedSinks });
      const decisionBase = {
        captureId: input.captureId,
        effectId: input.token.effectId,
        key: proposal?.key ?? `captured_${digest(identity).slice(0, 12)}`,
        path: candidate.path,
        label,
        allowedSinks,
        valueDigest,
        decisionRevision: input.token.decisionRevision,
        reason,
        ...publicProvenance,
      };
      decisions.push({ ...decisionBase, decisionDigest: digest(decisionBase) });
    }

    this.#settledCaptures.set(input.captureId, { settlementDigest, decisions });
    this.#activeBarriers.delete(input.token.effectId);
    return structuredClone(decisions);
  }

  decision(
    captureId: string,
    path: ProtectionPath,
    sink: ProtectionSink,
    decisionRevision: number,
  ): ProtectionDecision {
    const settled = this.#settledCaptures.get(captureId);
    const decision = settled?.decisions.find(
      (candidate) => pathIdentity(candidate.path) === pathIdentity(path),
    );
    if (!decision) throw new Error("protection_decision_missing");
    if (decision.decisionRevision !== decisionRevision)
      throw new Error("protection_decision_stale");
    if (decision.label === "public" && !decision.allowedSinks.includes(sink))
      throw new Error("protection_sink_not_authorized");
    return structuredClone(decision);
  }

  emit(
    value: ProtectionCandidate["value"],
    decision: ProtectionDecision,
    sink: ProtectionSink,
  ): ProtectionCandidate["value"] | string {
    if (this.hasActiveBarrier) return QUARANTINED;
    const current = this.decision(
      decision.captureId,
      decision.path,
      sink,
      decision.decisionRevision,
    );
    if (digestText(scalarText(value)) !== current.valueDigest)
      throw new Error("protection_value_decision_mismatch");
    return current.label === "public" ? value : MASK;
  }

  sanitize(
    input: string,
    sink: ProtectionSink = "agent_observation",
    forceQuarantine = false,
  ): string {
    if (forceQuarantine || this.hasActiveBarrier) return QUARANTINED;
    return this.#sanitizeKnown(input, sink);
  }

  #sanitizeKnown(input: string, sink: ProtectionSink): string {
    const restorations: Array<{ placeholder: string; value: string }> = [];
    let protectedInput = this.#currentClassifier().sanitizeExact(input);
    for (const [index, item] of this.#publicValues.entries()) {
      if (!item.allowedSinks.includes(sink) || !item.value || !protectedInput.includes(item.value))
        continue;
      const placeholder = `\uE000${index}\uE001`;
      protectedInput = protectedInput.split(item.value).join(placeholder);
      restorations.push({ placeholder, value: item.value });
    }
    let output = new SensitiveValueClassifier().sanitize(protectedInput);
    for (const { placeholder, value } of restorations)
      output = output.split(placeholder).join(value);
    return output;
  }

  sanitizeValue(
    value: unknown,
    key = "",
    sink: ProtectionSink = "agent_observation",
    forceQuarantine = false,
  ): unknown {
    if (typeof value === "string") return this.sanitize(value, sink, forceQuarantine);
    if (Array.isArray(value))
      return value.map((item) => this.sanitizeValue(item, key, sink, forceQuarantine));
    if (!value || typeof value !== "object") return value;
    const entries = Object.entries(value).map(
      ([childKey, child]) =>
        [
          // Object keys carry the transport schema. Quarantine their values, while
          // still scanning keys against already known protected material.
          this.#sanitizeKnown(childKey, sink),
          this.sanitizeValue(child, childKey, sink, forceQuarantine),
        ] as const,
    );
    if (new Set(entries.map(([childKey]) => childKey)).size !== entries.length)
      throw new Error("protection_sanitized_key_collision");
    return Object.fromEntries(entries);
  }

  abort(token: ProtectionBarrierToken): void {
    this.#assertCurrentToken(token);
    this.#activeBarriers.delete(token.effectId);
  }

  #assertCurrentToken(token: ProtectionBarrierToken): void {
    const current = this.#activeBarriers.get(token.effectId);
    if (
      !current ||
      current.scopeDigest !== token.scopeDigest ||
      current.scopeDigest !== this.#scopeDigest ||
      current.decisionRevision !== token.decisionRevision
    )
      throw new Error("protection_barrier_token_stale");
  }

  #isKnownProtected(candidate: ProtectionCandidate): boolean {
    // Cross-capture taint is meaningful for string-bearing secrets. Treating common
    // structural scalars such as true, false, or null as global secrets poisons
    // unrelated later captures that legitimately contain the same primitive.
    if (typeof candidate.value !== "string") return false;
    return [...this.#protectedValues.values()].some((value) => value === candidate.value);
  }

  #registerProtected(name: string, candidate: ProtectionCandidate): void {
    if (typeof candidate.value === "string" && candidate.value.length > 0)
      this.#protectedValues.set(name, candidate.value);
  }

  #currentClassifier(): SensitiveValueClassifier {
    return new SensitiveValueClassifier({
      protectedValues: Object.fromEntries(this.#protectedValues),
    });
  }
}
