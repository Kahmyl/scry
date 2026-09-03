import { Injectable } from "@nestjs/common";
import {
  proposedOperationContractSchema,
  type OperationContractFacts,
  type PraxisObservation,
  type ProposedOperationContract,
} from "@scry/contracts";

type Control = PraxisObservation["semanticPageContext"]["controls"][number];
type Projected = {
  facts: OperationContractFacts;
  activationControlReference: string;
  inputControlReferences: Record<string, string>;
};

@Injectable()
export class VitractObservedOperationContractProvider {
  readonly adapterKey = "vitract_registered";
  readonly adapterVersion = 1;

  project(praxisSessionId: string, observation: PraxisObservation): ProposedOperationContract[] {
    const url = new URL(observation.url);
    const projected =
      url.origin === "https://preview.vitract.com"
        ? this.credentialIssuance(url, observation.semanticPageContext.controls)
        : url.origin === "https://preview-api.vitract.com" &&
            url.pathname === "/api/docs/partner-api"
          ? this.partnerApi(observation.semanticPageContext.controls)
          : [];
    return projected.map((candidate, index) =>
      proposedOperationContractSchema.parse({
        facts: candidate.facts,
        provenance: {
          sourceKind: "runtime_observation",
          observationId: `vitract-registered-operation-contract:${index}:${candidate.facts.operation.key}`,
          origin: url.origin,
          observedAt: new Date().toISOString(),
          sourcePraxisSessionId: praxisSessionId,
          sourceDocumentEpoch: observation.documentEpoch,
        },
        interaction: {
          praxisSessionId,
          documentEpoch: observation.documentEpoch,
          origin: url.origin,
          activationControlReference: candidate.activationControlReference,
          inputControlReferences: candidate.inputControlReferences,
        },
      }),
    );
  }

  private credentialIssuance(url: URL, controls: Control[]): Projected[] {
    const match = /^\/partner\/developer\/applications\/([^/]+)\/credentials$/.exec(url.pathname);
    if (!match) return [];
    const activation = exactControl(controls, "Add credential", "activate", "form");
    const name = exactControl(controls, "Name", "enter_text", "form");
    if (!activation || !name) return [];
    return [
      {
        facts: {
          application: { key: "vitract_preview", provider: "vitract" },
          adapter: { key: this.adapterKey, version: this.adapterVersion },
          operation: {
            key: "issuePartnerCredential",
            label: "Add credential",
            method: "POST",
            pathTemplate: "/api/v1/partners/applications/{applicationId}/credentials",
            transports: ["xhr", "fetch"],
            semantics: {
              dispatch: "mutation",
              effects: ["business_effect", "protected_acquisition"],
            },
          },
          inputs: [
            {
              key: "credentialName",
              label: "Name",
              aliases: ["Credential name"],
              required: true,
              classification: "public",
              acceptedPresentations: ["plain_text"],
            },
          ],
          auth: { presentationClasses: [] },
          response: {
            statusClasses: [2],
            mutationPolicy: {
              confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429],
            },
            outputs: [
              output("credentialRecordId", "id", "public", "$.id", "resource_identity", true),
              output("clientId", "Client ID", "public", "$.clientId", undefined, true),
              output(
                "clientSecret",
                "Client secret",
                "protected",
                "$.clientSecret",
                undefined,
                true,
              ),
            ],
            continuation: "none",
          },
          resourceEffect: {
            operation: "create",
            provider: "vitract",
            resourceKind: "credential_record",
            resourceScope: decodeURIComponent(match[1]!),
            identityContractVersion: 1,
            identityOutputKey: "credentialRecordId",
            correlationFieldKey: "credentialName",
          },
        },
        activationControlReference: activation.reference,
        inputControlReferences: { credentialName: name.reference },
      },
    ];
  }

  private partnerApi(controls: Control[]): Projected[] {
    const projected: Projected[] = [];
    const create = exactControl(controls, "Run POST", "activate", "Create Order");
    const createClientId = exactControl(controls, "Client ID", "enter_text", "Create Order");
    const createSecret = exactControl(controls, "Client secret", "enter_text", "Create Order");
    const idempotency = exactControl(controls, "Idempotency-Key", "enter_text", "Create Order");
    const jsonBody = exactControl(controls, "JSON body", "enter_text", "Create Order");
    const acknowledgement = controls.filter(
      (control) =>
        control.role === "checkbox" &&
        control.name ===
          "I understand this sends a real request that may create or change Partner data." &&
        control.group === "Create Order examples",
    );
    if (acknowledgement.length > 1) return [];
    if (create && createClientId && createSecret && idempotency && jsonBody)
      projected.push({
        facts: {
          application: { key: "vitract_preview", provider: "vitract" },
          adapter: { key: this.adapterKey, version: this.adapterVersion },
          operation: {
            key: "createOrder",
            label: "Create Order",
            method: "POST",
            pathTemplate: "/api/v1/partner-api/orders",
            transports: ["fetch"],
            semantics: { dispatch: "mutation", effects: ["authentication", "business_effect"] },
          },
          inputs: [
            ...(acknowledgement[0]
              ? [
                  {
                    key: "requestAcknowledgement",
                    label: acknowledgement[0].name,
                    aliases: [],
                    required: true,
                    classification: "public" as const,
                    acceptedPresentations: ["plain_text" as const],
                    checkbox: { requiredState: true },
                  },
                ]
              : []),
            input("clientId", "Client ID", "generated_safe"),
            input("clientSecret", "Client secret", "protected"),
            {
              ...input("idempotencyKey", "Idempotency-Key", "protected"),
              syntheticInput: {
                generatorContract: "opaque_operation_token",
                generatorVersion: 1,
                purpose: "test_order_qualification",
              },
            },
            {
              ...input("orderPayload", "JSON body", "protected", "json_protected"),
              syntheticInput: {
                generatorContract: "nested_client_order_json",
                generatorVersion: 1,
                purpose: "test_order_qualification",
              },
            },
          ],
          auth: { presentationClasses: ["protected_text", "json_protected"] },
          response: {
            statusClasses: [2],
            mutationPolicy: {
              confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429],
            },
            outputs: [output("orderId", "id", "public", "$.data.id", "resource_identity", true)],
            continuation: "read_only_retrieve",
          },
          resourceEffect: {
            operation: "create",
            provider: "vitract",
            resourceKind: "order",
            resourceScope: "partner_api",
            identityContractVersion: 1,
            identityOutputKey: "orderId",
          },
          retrieval: {
            canonicalTargetFieldKey: "orderId",
            pathTemplate: "/api/v1/partner-api/orders/{orderId}",
          },
        },
        activationControlReference: create.reference,
        inputControlReferences: {
          ...(acknowledgement[0] ? { requestAcknowledgement: acknowledgement[0].reference } : {}),
          clientId: createClientId.reference,
          clientSecret: createSecret.reference,
          idempotencyKey: idempotency.reference,
          orderPayload: jsonBody.reference,
        },
      });
    const retrieve = exactControl(controls, "Run", "activate", "Retrieve Order examples");
    const retrieveClientId = exactControl(
      controls,
      "Client ID",
      "enter_text",
      "Retrieve Order examples",
    );
    const retrieveSecret = exactControl(
      controls,
      "Client secret",
      "enter_text",
      "Retrieve Order examples",
    );
    const orderId = exactControl(controls, "orderId", "enter_text", "Retrieve Order examples");
    if (retrieve && retrieveClientId && retrieveSecret && orderId)
      projected.push({
        facts: {
          application: { key: "vitract_preview", provider: "vitract" },
          adapter: { key: this.adapterKey, version: this.adapterVersion },
          operation: {
            key: "retrieveOrder",
            label: "Retrieve Order",
            method: "GET",
            pathTemplate: "/api/v1/partner-api/orders/{orderId}",
            transports: ["fetch", "xhr"],
            semantics: { dispatch: "read_only", effects: ["authentication", "read"] },
          },
          inputs: [
            input("clientId", "Client ID", "generated_safe"),
            input("clientSecret", "Client secret", "protected"),
            input("orderId", "orderId", "generated_safe", "plain_text", ["Order ID"]),
          ],
          auth: { presentationClasses: ["protected_text"] },
          response: {
            statusClasses: [2],
            outputs: [
              output("orderId", "id", "public", "$.data.id", "continuation_identity", true),
            ],
            continuation: "none",
          },
          retrieval: {
            canonicalTargetFieldKey: "orderId",
            pathTemplate: "/api/v1/partner-api/orders/{orderId}",
          },
        },
        activationControlReference: retrieve.reference,
        inputControlReferences: {
          clientId: retrieveClientId.reference,
          clientSecret: retrieveSecret.reference,
          orderId: orderId.reference,
        },
      });
    return projected;
  }
}

function exactControl(controls: Control[], name: string, capability: string, scope: string) {
  const matches = controls.filter(
    (control) =>
      control.name === name &&
      control.capabilities.includes(capability as never) &&
      (control.group === scope ||
        (scope === "Create Order" && control.group === "Create Order examples") ||
        control.boundary?.name === scope ||
        control.boundary?.kind === scope),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function input(
  key: string,
  label: string,
  classification: "protected" | "generated_safe",
  presentation: "plain_text" | "protected_text" | "json_protected" = classification === "protected"
    ? "protected_text"
    : "plain_text",
  aliases: string[] = [],
) {
  return {
    key,
    label,
    aliases,
    required: true,
    classification,
    acceptedPresentations: [presentation],
  };
}

function output(
  key: string,
  label: string,
  classification: "public" | "protected",
  path: string,
  identityRole?: "resource_identity" | "continuation_identity",
  generatedValueEligible = false,
) {
  return {
    key,
    label,
    classification,
    extractor: { kind: "json_path" as const, path },
    ...(identityRole ? { identityRole } : {}),
    generatedValueEligible,
  };
}
