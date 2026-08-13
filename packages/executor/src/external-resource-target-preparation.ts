import {
  externalResourcePresentationContractSchema,
  type ExternalResourcePresentationContract,
} from "@scry/contracts";
import { inspectSemanticScope, resolveTarget, type GroundingResult } from "@scry/praxis";
import type { Page } from "playwright";

export const externalResourcePresentationFailureCodes = [
  "EXTERNAL_BINDING_UNAVAILABLE",
  "RESOURCE_OBSERVATION_UNAVAILABLE",
  "CANONICAL_RESOURCE_NOT_FOUND",
  "CANONICAL_RESOURCE_DUPLICATE",
  "PRESENTATION_IDENTITY_UNAVAILABLE",
  "PRESENTATION_IDENTITY_NOT_INTERNAL_SAFE",
  "PRESENTATION_IDENTITY_AMBIGUOUS",
  "PRESENTATION_IDENTITY_DRIFTED",
  "BROWSER_BOUNDARY_NOT_FOUND",
  "BROWSER_BOUNDARY_AMBIGUOUS",
  "ACTION_TARGET_NOT_FOUND",
  "ACTION_TARGET_AMBIGUOUS",
  "PROVIDER_REVALIDATION_FAILED",
  "PRAXIS_REVALIDATION_FAILED",
] as const;

export type ExternalResourcePresentationFailureCode =
  (typeof externalResourcePresentationFailureCodes)[number];

export class ExternalResourcePresentationError extends Error {
  constructor(readonly code: ExternalResourcePresentationFailureCode) {
    super(code);
    this.name = "ExternalResourcePresentationError";
  }
}

export type TrustedExternalSemanticIdentity = {
  sourceProtectedOperationId: string;
  projectId: string;
  environmentId: string;
  externalIdentity: string;
  provider: string;
  resourceKind: string;
  resourceScope: string;
  identityContractVersion: number;
};

export type ExternalResourceObservationField = {
  semanticField: string;
  classification: "internal_non_secret" | "protected";
  value: string;
};

export type AuthoritativeExternalResourceObservation = {
  observationId: string;
  source: "authoritative_read_only_resource_observation";
  resourceCollection: string;
  projectId: string;
  environmentId: string;
  provider: string;
  resourceKind: string;
  resourceScope: string;
  records: Array<{
    canonicalIdentity: string;
    presentationFields: ExternalResourceObservationField[];
  }>;
};

export type PreparedExternalResourceTarget = GroundingResult & {
  providerRevalidated: true;
  presentationIdentityValidated: true;
};

export async function prepareExternalResourceDestructiveTarget(input: {
  page: Page;
  binding: TrustedExternalSemanticIdentity;
  expectedOwnership: { projectId: string; environmentId: string };
  presentationContract: ExternalResourcePresentationContract;
  observeResources(input: {
    phase: "initial" | "pre_dispatch";
    contract: ExternalResourcePresentationContract;
  }): Promise<AuthoritativeExternalResourceObservation>;
  allowedOrigins: string[];
}): Promise<PreparedExternalResourceTarget> {
  const contract = externalResourcePresentationContractSchema.parse(input.presentationContract);
  assertBinding(input.binding, input.expectedOwnership, contract);

  const initialObservation = await observe(input, "initial");
  const initial = projectPresentation(input.binding, contract, initialObservation);

  const boundary = await inspectSemanticScope(input.page, {
    kind: contract.browserBoundary.kind,
    name: initial,
  }, { allowedOrigins: input.allowedOrigins });
  if (boundary.matchCount === 0)
    throw new ExternalResourcePresentationError("BROWSER_BOUNDARY_NOT_FOUND");
  if (boundary.matchCount !== 1)
    throw new ExternalResourcePresentationError("BROWSER_BOUNDARY_AMBIGUOUS");

  let target: GroundingResult;
  try {
    target = await resolveTarget(input.page, {
      ...contract.action,
      scope: {
        kind: contract.browserBoundary.kind,
        name: initial,
      },
    }, { allowedOrigins: input.allowedOrigins });
  } catch (error) {
    throw mapGroundingFailure(error);
  }

  const revalidationObservation = await observe(input, "pre_dispatch");
  if (revalidationObservation.observationId === initialObservation.observationId)
    throw new ExternalResourcePresentationError("PROVIDER_REVALIDATION_FAILED");
  const revalidated = projectPresentation(input.binding, contract, revalidationObservation);
  if (normalize(revalidated) !== normalize(initial))
    throw new ExternalResourcePresentationError("PRESENTATION_IDENTITY_DRIFTED");

  try {
    await target.revalidate();
  } catch {
    throw new ExternalResourcePresentationError("PRAXIS_REVALIDATION_FAILED");
  }
  return Object.assign(target, {
    providerRevalidated: true as const,
    presentationIdentityValidated: true as const,
  });
}

function assertBinding(
  binding: TrustedExternalSemanticIdentity,
  ownership: { projectId: string; environmentId: string },
  contract: ExternalResourcePresentationContract,
) {
  if (
    binding.projectId !== ownership.projectId ||
    binding.environmentId !== ownership.environmentId ||
    binding.provider !== contract.resource.provider ||
    binding.resourceKind !== contract.resource.kind ||
    binding.resourceScope !== contract.resource.scope ||
    !binding.externalIdentity ||
    binding.identityContractVersion < 1
  ) throw new ExternalResourcePresentationError("EXTERNAL_BINDING_UNAVAILABLE");
}

async function observe(
  input: Parameters<typeof prepareExternalResourceDestructiveTarget>[0],
  phase: "initial" | "pre_dispatch",
) {
  let observation: AuthoritativeExternalResourceObservation;
  try {
    observation = await input.observeResources({ phase, contract: input.presentationContract });
  } catch (error) {
    if (error instanceof ExternalResourcePresentationError) throw error;
    throw new ExternalResourcePresentationError(
      phase === "initial" ? "RESOURCE_OBSERVATION_UNAVAILABLE" : "PROVIDER_REVALIDATION_FAILED",
    );
  }
  if (
    !observation.observationId ||
    observation.source !== "authoritative_read_only_resource_observation" ||
    observation.resourceCollection !== input.presentationContract.presentationObservation.resourceCollection ||
    observation.projectId !== input.binding.projectId ||
    observation.environmentId !== input.binding.environmentId ||
    observation.provider !== input.binding.provider ||
    observation.resourceKind !== input.binding.resourceKind ||
    observation.resourceScope !== input.binding.resourceScope ||
    !Array.isArray(observation.records)
  ) throw new ExternalResourcePresentationError(
    phase === "initial" ? "RESOURCE_OBSERVATION_UNAVAILABLE" : "PROVIDER_REVALIDATION_FAILED",
  );
  return observation;
}

function projectPresentation(
  binding: TrustedExternalSemanticIdentity,
  contract: ExternalResourcePresentationContract,
  observation: AuthoritativeExternalResourceObservation,
) {
  const canonical = observation.records.filter(
    (record) => record.canonicalIdentity === binding.externalIdentity,
  );
  if (canonical.length === 0)
    throw new ExternalResourcePresentationError("CANONICAL_RESOURCE_NOT_FOUND");
  if (canonical.length !== 1)
    throw new ExternalResourcePresentationError("CANONICAL_RESOURCE_DUPLICATE");

  const fields = canonical[0]!.presentationFields.filter(
    (field) => field.semanticField === contract.presentationIdentity.semanticField,
  );
  if (fields.length !== 1 || !fields[0]!.value.trim())
    throw new ExternalResourcePresentationError("PRESENTATION_IDENTITY_UNAVAILABLE");
  if (fields[0]!.classification !== "internal_non_secret")
    throw new ExternalResourcePresentationError("PRESENTATION_IDENTITY_NOT_INTERNAL_SAFE");

  const presentation = normalize(fields[0]!.value);
  let matchCount = 0;
  for (const record of observation.records) {
    const candidates = record.presentationFields.filter(
      (field) =>
        field.semanticField === contract.presentationIdentity.semanticField &&
        normalize(field.value) === presentation,
    );
    if (candidates.length > 1) {
      matchCount += candidates.length;
    } else if (candidates.length === 1) {
      matchCount += 1;
    }
  }
  if (matchCount !== 1)
    throw new ExternalResourcePresentationError("PRESENTATION_IDENTITY_AMBIGUOUS");
  return fields[0]!.value.trim();
}

function mapGroundingFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error))
    return new ExternalResourcePresentationError("ACTION_TARGET_NOT_FOUND");
  const candidate = error as { code?: unknown; diagnostic?: { candidateCount?: unknown } };
  if (candidate.code === "TARGET_SCOPE_INVALID") {
    return new ExternalResourcePresentationError(
      typeof candidate.diagnostic?.candidateCount === "number" &&
      candidate.diagnostic.candidateCount > 1
        ? "BROWSER_BOUNDARY_AMBIGUOUS"
        : "BROWSER_BOUNDARY_NOT_FOUND",
    );
  }
  if (candidate.code === "TARGET_AMBIGUOUS")
    return new ExternalResourcePresentationError("ACTION_TARGET_AMBIGUOUS");
  return new ExternalResourcePresentationError("ACTION_TARGET_NOT_FOUND");
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
