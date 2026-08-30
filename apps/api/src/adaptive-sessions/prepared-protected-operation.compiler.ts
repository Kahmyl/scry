import {
  missionAuthoringIntentSchema,
  type MissionAuthoringIntent,
  type ObservedOperationContract,
} from "@scry/contracts";

import { compileMissionAuthoringProtectedTransaction } from "./mission-authoring-protected-transaction.js";

type ExecutionMaterial = {
  protectedOperationId: string;
  publicOperationId: string;
  objectiveId: string;
  flowDraftId: string;
  authorizationId: string;
  contractFacts: Pick<
    ObservedOperationContract,
    "operation" | "inputs" | "response" | "resourceEffect"
  >;
  values: Array<{
    canonicalFieldKey: string;
    targetReference: string;
    presentationClass: "plain_text" | "protected_text" | "json_public" | "json_protected";
    sourceKind:
      | "literal_public"
      | "stored_public"
      | "protected_reference"
      | "generated_safe"
      | "synthetic_protected";
    sourceReferenceId: string | null;
    publicValue: string | null;
    storedPublicValue: string | null;
  }>;
  expectedOutputs: Array<{ key: string; classification: "public" | "protected" }>;
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
    const protectedValue = ["protected_reference", "synthetic_protected"].includes(
      value.sourceKind,
    );
    if (protectedValue && !value.sourceReferenceId)
      throw new Error("PREPARED_OPERATION_PROTECTED_REFERENCE_MISSING");
    const publicValue = value.publicValue ?? value.storedPublicValue;
    if (!protectedValue && publicValue === null)
      throw new Error("PREPARED_OPERATION_PUBLIC_VALUE_MISSING");
    return missionAuthoringIntentSchema.parse({
      intentId: `${input.material.publicOperationId}-field-${index}`,
      objectiveId: input.material.objectiveId,
      flowDraftId: input.material.flowDraftId,
      action: {
        kind: "fill",
        target: {
          concept: value.canonicalFieldKey,
          reference: value.targetReference,
          role: "textbox",
          label: field.label,
          exact: true,
        },
        ...(protectedValue ? { protectedReferenceId: value.sourceReferenceId } : { publicValue }),
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs, allowNewPage: false, allowNonExact: false },
      authorization: protectedValue
        ? { kind: "live_mutation", authorizationId: input.material.authorizationId }
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
  if (resourceEffect && !correlationValue)
    throw new Error("PREPARED_OPERATION_RESOURCE_CORRELATION_VALUE_MISSING");
  const intent = missionAuthoringIntentSchema.parse({
    intentId: input.material.publicOperationId,
    objectiveId: input.material.objectiveId,
    flowDraftId: input.material.flowDraftId,
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: preparation.map((item) => item.intentId),
      mutation: {
        kind: operation.classification === "read_only" ? "read_only" : "one_time",
        target: {
          concept: operation.key,
          reference: operation.activationControlReference,
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
      response: {
        confirmedNotAppliedStatuses:
          input.material.contractFacts.response.confirmedNotAppliedStatuses,
      },
      outputs: input.material.expectedOutputs.map((output) => ({
        reference: output.key,
        classification: output.classification,
        target: {
          concept: output.key,
          role: "value",
          name:
            input.material.contractFacts.response.safeOutputs?.find(
              (candidate) => candidate.key === output.key,
            )?.label ?? output.key,
          exact: false,
        },
        storageName: `${operation.label} ${output.key}`.slice(0, 200),
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
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs, allowNewPage: false, allowNonExact: true },
    authorization: {
      kind: "protected_mutation",
      authorizationId: input.material.authorizationId,
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
