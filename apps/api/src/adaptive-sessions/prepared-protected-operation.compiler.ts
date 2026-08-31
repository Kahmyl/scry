import {
  missionAuthoringIntentSchema,
  type MissionAuthoringIntent,
  type OperationContractFacts,
} from "@scry/contracts";

import { compileMissionAuthoringProtectedTransaction } from "./mission-authoring-protected-transaction.js";

type ExecutionMaterial = {
  protectedOperationId: string;
  publicOperationId: string;
  objectiveId: string;
  flowDraftId: string;
  preparedExecutionCapabilityId: string;
  contractFacts: OperationContractFacts;
  activationControlReference: string;
  values: Array<{
    canonicalFieldKey: string;
    targetReference: string;
    presentationClass: "plain_text" | "protected_text" | "json_public" | "json_protected";
    sourceKind:
      | "literal_public"
      | "stored_public"
      | "protected_reference"
      | "generated_safe"
      | "generated_protected"
      | "synthetic_protected";
    sourceReferenceId: string | null;
    publicValue: string | null;
    storedPublicValue: string | null;
  }>;
  expectedOutputs: Array<{
    reference: string;
    classification: "public" | "protected";
    storageName: string;
  }>;
};

export function compilePreparedProtectedOperation(input: {
  material: ExecutionMaterial;
  entryUrl: string;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const fields = new Map(input.material.contractFacts.inputs.map((field) => [field.key, field]));
  const preparation: MissionAuthoringIntent[] = input.material.values.map((value, index) => {
    const field = fields.get(value.canonicalFieldKey);
    if (!field) throw new Error("PREPARED_OPERATION_FIELD_CONTRACT_MISSING");
    const protectedValue = [
      "protected_reference",
      "generated_protected",
      "synthetic_protected",
    ].includes(value.sourceKind);
    if (protectedValue && !value.sourceReferenceId)
      throw new Error("PREPARED_OPERATION_PROTECTED_REFERENCE_MISSING");
    const publicValue = value.publicValue ?? value.storedPublicValue;
    if (!protectedValue && publicValue === null)
      throw new Error("PREPARED_OPERATION_PUBLIC_VALUE_MISSING");
    if (
      field.checkbox &&
      (protectedValue ||
        !["true", "false"].includes(String(publicValue)) ||
        (field.checkbox.requiredState !== undefined &&
          String(field.checkbox.requiredState) !== publicValue))
    )
      throw new Error("PREPARED_OPERATION_CHECKBOX_VALUE_INVALID");
    return missionAuthoringIntentSchema.parse({
      intentId: `${input.material.publicOperationId}-field-${index}`,
      objectiveId: input.material.objectiveId,
      flowDraftId: input.material.flowDraftId,
      action: field.checkbox
        ? {
            kind: "set_checked",
            checked: publicValue === "true",
            target: {
              concept: value.canonicalFieldKey,
              reference: value.targetReference,
              role: "checkbox",
              label: field.label,
              exact: true,
            },
          }
        : {
            kind: "fill",
            target: {
              concept: value.canonicalFieldKey,
              reference: value.targetReference,
              role: "textbox",
              label: field.label,
              exact: true,
            },
            ...(protectedValue
              ? { protectedReferenceId: value.sourceReferenceId }
              : { publicValue }),
          },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs, allowNewPage: false, allowNonExact: false },
      authorization: protectedValue
        ? {
            kind: "prepared_execution",
            preparedExecutionCapabilityId: input.material.preparedExecutionCapabilityId,
          }
        : { kind: "ordinary" },
      protectedInputReferences: protectedValue ? [value.sourceReferenceId] : [],
    });
  });
  const operation = input.material.contractFacts.operation;
  const resourceEffect = input.material.contractFacts.resourceEffect;
  const correlation = resourceEffect
    ? input.material.values.find(
        (value) => value.canonicalFieldKey === resourceEffect.correlationFieldKey,
      )
    : undefined;
  const correlationValue = correlation?.publicValue ?? correlation?.storedPublicValue;
  if (resourceEffect?.correlationFieldKey && !correlationValue)
    throw new Error("PREPARED_OPERATION_RESOURCE_CORRELATION_VALUE_MISSING");
  const intent = missionAuthoringIntentSchema.parse({
    intentId: input.material.publicOperationId,
    objectiveId: input.material.objectiveId,
    flowDraftId: input.material.flowDraftId,
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: preparation.map((item) => item.intentId),
      mutation: {
        kind: operation.semantics.dispatch === "read_only" ? "read_only" : "one_time",
        target: {
          concept: operation.key,
          reference: input.material.activationControlReference,
          role: "button",
          label: operation.label,
          exact: true,
        },
      },
      request: {
        method: operation.method,
        pathTemplate: operation.pathTemplate,
        transports: operation.transports,
      },
      ...(input.material.contractFacts.response.mutationPolicy
        ? {
            response: {
              confirmedNotAppliedStatuses:
                input.material.contractFacts.response.mutationPolicy.confirmedNotAppliedStatuses,
            },
          }
        : {}),
      outputs: input.material.expectedOutputs.map((output) => ({
        reference: output.reference,
        classification: output.classification,
        target: {
          concept: output.reference,
          role: "value",
          name:
            input.material.contractFacts.response.outputs.find(
              (candidate) => candidate.key === output.reference,
            )?.label ?? output.reference,
          exact: false,
        },
        ...(() => {
          const extractor = input.material.contractFacts.response.outputs.find(
            (candidate) => candidate.key === output.reference,
          )?.extractor;
          return extractor?.kind === "json_path" ? { responseJsonPath: extractor.path } : {};
        })(),
        storageName: output.storageName,
      })),
      ...(resourceEffect
        ? {
            externalResourceBindings: [
              {
                status: "active" as const,
                identityReference: resourceEffect.identityOutputKey,
                provider: resourceEffect.provider,
                resourceKind: resourceEffect.resourceKind,
                resourceScope: resourceEffect.resourceScope,
                identityContractVersion: resourceEffect.identityContractVersion,
                identitySource: "response" as const,
                requiredForDestructiveLifecycle: true,
              },
            ],
            ...(resourceEffect.correlationFieldKey
              ? {
                  resourceEffect: {
                    operation: "create" as const,
                    provider: resourceEffect.provider,
                    resourceKind: resourceEffect.resourceKind,
                    resourceScope: resourceEffect.resourceScope,
                    identityContractVersion: resourceEffect.identityContractVersion,
                    correlation: {
                      field: resourceEffect.correlationFieldKey,
                      value: correlationValue!,
                      uniqueness: "resource_scope" as const,
                    },
                  },
                }
              : {}),
          }
        : {}),
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs, allowNewPage: false, allowNonExact: true },
    authorization: {
      kind: "prepared_execution",
      preparedExecutionCapabilityId: input.material.preparedExecutionCapabilityId,
    },
    protectedInputReferences: [],
  });
  const transaction = compileMissionAuthoringProtectedTransaction({
    operationId: input.material.publicOperationId,
    entryUrl: input.entryUrl,
    action: intent.action as Extract<
      MissionAuthoringIntent["action"],
      { kind: "acquire_protected_outputs" }
    >,
    preparation,
    timeoutMs,
  });
  return { intent, transaction };
}
