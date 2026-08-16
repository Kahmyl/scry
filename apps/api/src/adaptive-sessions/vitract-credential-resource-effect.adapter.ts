import type {
  AuthoritativeReconciliationProvider,
  AuthoritativeResourceReconciliation,
  UnknownOperationAuthority,
} from "./adaptive-operation-reconciliation.registry.js";

export type VitractCredentialRecord = {
  identity: string;
  label: string;
  state: string;
};

export type VitractCredentialSnapshot = {
  source: "authoritative_supported_resource_listing";
  records: VitractCredentialRecord[];
  observationId: string;
};

export type VitractCredentialResourceObserver = (
  input: Readonly<{ resourceScope: string; authority: Readonly<UnknownOperationAuthority> }>,
) => Promise<VitractCredentialSnapshot>;

type Correlation = { resourceScope: string; field: "label"; value: string };

/** Provider semantics only. Browser/API mechanics are supplied by the composition owner. */
export class VitractCredentialResourceEffectAdapter
  implements AuthoritativeReconciliationProvider
{
  readonly id = "vitract-credential-resource-effect-v1";

  constructor(private readonly observeResources: VitractCredentialResourceObserver) {}

  supports(authority: Readonly<UnknownOperationAuthority>) {
    return this.correlation(authority) !== null;
  }

  async observe(
    authority: Readonly<UnknownOperationAuthority>,
  ): Promise<AuthoritativeResourceReconciliation> {
    const correlation = this.correlation(authority);
    if (!correlation) return {
      result: "still_unknown",
      reasonCode: "RESOURCE_EFFECT_CONTRACT_UNAVAILABLE",
      evidence: { authoritativeObservation: false },
    };
    const snapshot = await this.observeResources({ resourceScope: correlation.resourceScope, authority });
    const matches = snapshot.records.filter((record) => record.label === correlation.value);
    const safeEvidence = {
      authoritativeObservation: true,
      observationId: snapshot.observationId,
      source: snapshot.source,
      matchingResourceCount: matches.length,
      correlationField: correlation.field,
    };
    if (matches.length !== 1) return {
      result: "still_unknown",
      reasonCode: matches.length === 0
        ? "AUTHORITATIVE_RESOURCE_ABSENCE_WITHOUT_BASELINE"
        : "AUTHORITATIVE_RESOURCE_CORRELATION_AMBIGUOUS",
      evidence: safeEvidence,
    };
    const resource = matches[0]!;
    const protectedOutputs = authority.authoringIntent?.action.kind === "acquire_protected_outputs"
      && authority.authoringIntent.action.outputs.some((output) => output.classification === "protected");
    const exactResource = {
      provider: "vitract",
      resourceKind: "credential_record",
      resourceScope: correlation.resourceScope,
      identity: resource.identity,
      state: resource.state,
    };
    const exactEvidence = { ...safeEvidence, resourceIdentity: resource.identity, resourceState: resource.state };
    if (protectedOutputs) return {
      result: "proven_applied_output_unrecovered",
      reasonCode: "AUTHORITATIVE_RESOURCE_PRESENT_PROTECTED_OUTPUT_UNRECOVERED",
      resource: exactResource,
      outputState: "unrecovered",
      evidence: exactEvidence,
    };
    return {
      result: "proven_applied",
      reasonCode: "AUTHORITATIVE_RESOURCE_PRESENT",
      resource: exactResource,
      outputState: "not_applicable",
      evidence: exactEvidence,
    };
  }

  private correlation(authority: Readonly<UnknownOperationAuthority>): Correlation | null {
    const intent = authority.authoringIntent;
    if (intent?.action.kind !== "acquire_protected_outputs") return null;
    const explicit = intent.action.resourceEffect;
    if (explicit) {
      if (
        explicit.operation !== "create" || explicit.provider !== "vitract" ||
        explicit.resourceKind !== "credential_record" || explicit.correlation.field !== "label"
      ) return null;
      return {
        resourceScope: explicit.resourceScope,
        field: "label",
        value: explicit.correlation.value,
      };
    }
    const entryUrl = authority.action.type === "protectedTransaction"
      ? authority.action.entry.url
      : null;
    const match = entryUrl?.match(/\/applications\/([^/]+)\/credentials(?:[/?#]|$)/);
    const fills = (authority.preparationFacts ?? []).filter(
      (fact) => fact.actionKind === "fill" && fact.publicValue,
    );
    if (!match || fills.length !== 1) return null;
    return { resourceScope: decodeURIComponent(match[1]!), field: "label", value: fills[0]!.publicValue! };
  }
}
