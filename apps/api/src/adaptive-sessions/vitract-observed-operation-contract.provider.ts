import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  observedOperationContractSchema,
  type ObservedOperationContract,
  type PraxisObservation,
} from "@scry/contracts";

type Control = PraxisObservation["semanticPageContext"]["controls"][number];
type OperationFacts = Omit<
  ObservedOperationContract,
  "id" | "digest" | "praxisSessionId" | "documentEpoch" | "origin" | "sourceKind" | "observationId"
>;

@Injectable()
export class VitractObservedOperationContractProvider {
  project(praxisSessionId: string, observation: PraxisObservation): ObservedOperationContract[] {
    const url = new URL(observation.url);
    const facts =
      url.origin === "https://preview.vitract.com"
        ? this.credentialIssuance(url, observation.semanticPageContext.controls)
        : url.origin === "https://preview-api.vitract.com" &&
            url.pathname === "/api/docs/partner-api"
          ? this.partnerApi(observation.semanticPageContext.controls)
          : [];
    return facts.map((contract, index) => {
      const provenance = {
        praxisSessionId,
        documentEpoch: observation.documentEpoch,
        origin: url.origin,
        sourceKind: "runtime_observation" as const,
        observationId: `vitract-registered-operation-contract:${index}:${contract.operation.key}`,
      };
      return observedOperationContractSchema.parse({
        id: randomUUID(),
        digest: digest({ ...provenance, facts: contract }),
        ...provenance,
        ...contract,
      });
    });
  }

  private credentialIssuance(url: URL, controls: Control[]): OperationFacts[] {
    const match = /^\/partner\/developer\/applications\/([^/]+)\/credentials$/.exec(url.pathname);
    if (!match) return [];
    const activation = exactControl(controls, "Add credential", "activate", "form");
    const name = exactControl(controls, "Name", "enter_text", "form");
    if (!activation || !name) return [];
    return [
      {
        operation: {
          key: "issuePartnerCredential",
          label: "Add credential",
          method: "POST" as const,
          pathTemplate: "/api/v1/partners/applications/{applicationId}/credentials",
          transports: ["xhr" as const, "fetch" as const],
          classification: "mutation" as const,
          activationControlReference: activation.reference,
        },
        inputs: [
          {
            key: "credentialName",
            label: "Name",
            aliases: ["Credential name"],
            required: true,
            classification: "public" as const,
            acceptedPresentations: ["plain_text" as const],
            controlReference: name.reference,
          },
        ],
        auth: { presentationClasses: [] },
        response: {
          statusClasses: [2],
          confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429],
          safeOutputKeys: ["credentialRecordId", "clientId", "clientSecret"],
          safeOutputs: [
            { key: "credentialRecordId", label: "id", classification: "public", path: "$.id" },
            { key: "clientId", label: "Client ID", classification: "public", path: "$.clientId" },
            {
              key: "clientSecret",
              label: "Client secret",
              classification: "protected",
              path: "$.clientSecret",
            },
          ],
          publicIdentityOutputPath: "$.id",
          continuation: "none" as const,
        },
        resourceEffect: {
          operation: "create" as const,
          provider: "vitract",
          resourceKind: "credential_record",
          resourceScope: decodeURIComponent(match[1]!),
          identityContractVersion: 1,
          identityOutputKey: "credentialRecordId",
          correlationFieldKey: "credentialName",
        },
      },
    ];
  }

  private partnerApi(controls: Control[]): OperationFacts[] {
    const contracts: OperationFacts[] = [];
    const create = exactControl(controls, "Run POST", "activate", "Create Order");
    const createClientId = exactControl(controls, "Client ID", "enter_text", "Create Order");
    const createSecret = exactControl(controls, "Client secret", "enter_text", "Create Order");
    const idempotency = exactControl(controls, "Idempotency-Key", "enter_text", "Create Order");
    const jsonBody = exactControl(controls, "JSON body", "enter_text", "Create Order");
    if (create && createClientId && createSecret && idempotency && jsonBody)
      contracts.push({
        operation: {
          key: "createOrder",
          label: "Create Order",
          method: "POST",
          pathTemplate: "/api/v1/partner-api/orders",
          transports: ["fetch"],
          classification: "mutation",
          activationControlReference: create.reference,
        },
        inputs: [
          input("clientId", "Client ID", "generated_safe", createClientId.reference),
          input("clientSecret", "Client secret", "protected", createSecret.reference),
          input("idempotencyKey", "Idempotency-Key", "protected", idempotency.reference),
          input("orderPayload", "JSON body", "protected", jsonBody.reference, "json_protected"),
        ],
        auth: { presentationClasses: ["protected_text", "json_protected"] },
        response: {
          statusClasses: [2],
          confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429],
          safeOutputKeys: ["orderId"],
          safeOutputs: [
            { key: "orderId", label: "id", classification: "public", path: "$.data.id" },
          ],
          publicIdentityOutputPath: "$.data.id",
          continuation: "read_only_retrieve",
        },
        retrieval: {
          canonicalTargetFieldKey: "orderId",
          pathTemplate: "/api/v1/partner-api/orders/{orderId}",
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
      contracts.push({
        operation: {
          key: "retrieveOrder",
          label: "Retrieve Order",
          method: "GET",
          pathTemplate: "/api/v1/partner-api/orders/{orderId}",
          transports: ["fetch", "xhr"],
          classification: "read_only",
          activationControlReference: retrieve.reference,
        },
        inputs: [
          input("clientId", "Client ID", "generated_safe", retrieveClientId.reference),
          input("clientSecret", "Client secret", "protected", retrieveSecret.reference),
          input("orderId", "orderId", "generated_safe", orderId.reference, "plain_text", [
            "Order ID",
          ]),
        ],
        auth: { presentationClasses: ["protected_text"] },
        response: {
          statusClasses: [2],
          confirmedNotAppliedStatuses: [],
          safeOutputKeys: ["orderId"],
          safeOutputs: [
            { key: "orderId", label: "id", classification: "public", path: "$.data.id" },
          ],
          publicIdentityOutputPath: "$.data.id",
          continuation: "none",
        },
        retrieval: {
          canonicalTargetFieldKey: "orderId",
          pathTemplate: "/api/v1/partner-api/orders/{orderId}",
        },
      });
    return contracts;
  }
}

function exactControl(controls: Control[], name: string, capability: string, scope: string) {
  const matches = controls.filter(
    (control) =>
      control.name === name &&
      control.capabilities.includes(capability as never) &&
      (control.group === scope ||
        control.boundary?.name === scope ||
        control.boundary?.kind === scope),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function input(
  key: string,
  label: string,
  classification: "protected" | "generated_safe",
  controlReference: string,
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
    controlReference,
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
