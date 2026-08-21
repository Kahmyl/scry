import { pathToFileURL } from "node:url";
import { chromium, errors as playwrightErrors, type Locator, type Page } from "playwright";
import {
  executionPolicySchema,
  type ExecutionPolicy,
  type InteractionTargetIntent,
  type MissionAuthoringIntent,
} from "@scry/contracts";
import { resolveTarget, resolveTargetLocator } from "@scry/praxis";
import { SecretRedactor } from "@scry/policy";
import { navigateAndWaitNative } from "@scry/executor";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/database.js";

const EXPECTED = {
  clientIdReference: "e2eb0fbc-7fdc-46f9-a016-c53558e5e637",
  clientSecretReference: "98e1d42d-578a-4ba4-a70b-442f7d983cdb",
  loginEmailReference: "045970aa-9210-47e7-bafa-18ce4da5089c",
  loginPasswordReference: "6547b053-f2b8-420c-91c0-bb4e1c7ae2a6",
  projectId: "6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1",
  environmentId: "9a581bb0-2276-4888-9ddb-07b2485cddc3",
  authoringSessionId: "ec2f4d10-e7a3-4a36-8d25-d00cf692ba05",
  flowDraftId: "e5d6971e-320e-4c61-83dc-b3c7c2839ce7",
  originProtectedOperationId: "64d30899-8278-4a42-89b9-c34dce6b000f",
  historicalOperationId: "m2-3aeb032a39eb3889f812c10550e2885d07864c12",
  missionId: "8c0a9e3a-56a7-4286-a331-1e73c0129533",
  objectiveId: "e5c0f365-d373-4375-9005-38a16bce770c",
  agentSessionId: "925f7e55-1562-411a-8a62-c7b0434fe36c",
  correlationId: "23dff597-c0d7-4ba7-94b5-959c04daa17b",
  idempotencyKey: "vitract-revoke-target-rehearsal-v3-production-policy-preparation",
  loginUrl: "https://preview.vitract.com/login",
  credentialUrl:
    "https://preview.vitract.com/partner/developer/applications/vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a/credentials",
} as const;

export const STAGES = [
  "ENVIRONMENT_POLICY_RESOLUTION",
  "SESSION_CREATE",
  "PREPARED_SESSION_RESOLUTION",
  "RUNTIME_POLICY_RESOLUTION",
  "REFERENCE_ADMISSION",
  "EMAIL_REFERENCE_RESOLUTION",
  "PASSWORD_REFERENCE_RESOLUTION",
  "TARGET_CREDENTIAL_PAIR_REVALIDATION",
  "BROWSER_LAUNCH",
  "LOGIN_NAVIGATION",
  "EMAIL_GROUNDING",
  "EMAIL_FILL",
  "PASSWORD_GROUNDING",
  "PASSWORD_FILL",
  "LOGIN_GROUNDING",
  "LOGIN_DISPATCH",
  "PROVIDER_RESPONSE",
  "AUTHENTICATED_READINESS",
  "CREDENTIAL_PAGE_NAVIGATION",
  "CREDENTIAL_PAGE_OBSERVATION",
] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = "not_started" | "started" | "succeeded" | "failed" | "timed_out";
export type SafeRejectedCapabilitySignature = {
  count: number;
  nativeKindClass: "input" | "textarea" | "other";
  computedRoleClass: "textbox" | "other";
  visible: "yes" | "no" | "unknown";
  enabled: "yes" | "no" | "unknown";
  readonly: "yes" | "no" | "unknown";
  acceptsText: "yes" | "no" | "unknown";
  focusable: "yes" | "no" | "unknown";
  editable: "yes" | "no" | "unknown";
};
export type SafeGroundingDiagnostic = {
  candidateCount: number;
  eligibleCount: number;
  confidence: number;
  confidenceMargin: number;
  rejectedConstraints: string[];
  scopeKind: string;
  observationStatus: string;
  observationPhase?: string;
  observationReasonCode?: string;
  rejectedCapabilitySignatures: SafeRejectedCapabilitySignature[];
};
export type NativePraxisTelemetry = {
  nativeAttempted: "yes" | "no";
  nativeSucceeded: "yes" | "no";
  nativeFailureCode: string;
  praxisFallbackAttempted: "yes" | "no";
  praxisSucceeded: "yes" | "no";
  praxisFailureCode: string;
};
export type StageTelemetry = Record<
  StageName,
  {
    status: StageStatus;
    code?: string;
    grounding?: SafeGroundingDiagnostic;
    resolution?: NativePraxisTelemetry;
  }
>;
export function emptyTelemetry(): StageTelemetry {
  return Object.fromEntries(
    STAGES.map((stage) => [stage, { status: "not_started" }]),
  ) as StageTelemetry;
}
export function safeFailureCode(stage: StageName, error: unknown) {
  const direct =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (direct && /^[A-Z][A-Z0-9_]+$/.test(direct)) return direct;
  const response =
    error && typeof error === "object" && "response" in error
      ? (error as { response?: unknown }).response
      : undefined;
  const existing =
    response &&
    typeof response === "object" &&
    "code" in response &&
    typeof (response as { code?: unknown }).code === "string"
      ? (response as { code: string }).code
      : undefined;
  if (existing && /^[A-Z][A-Z0-9_]+$/.test(existing)) return existing;
  const timeout = error instanceof Error && /timeout/i.test(error.name + error.message);
  if (timeout) return `REHEARSAL_${stage}_TIMED_OUT`;
  const specific: Partial<Record<StageName, string>> = {
    ENVIRONMENT_POLICY_RESOLUTION: "REHEARSAL_ENVIRONMENT_POLICY_UNAVAILABLE",
    RUNTIME_POLICY_RESOLUTION: "REHEARSAL_RUNTIME_POLICY_UNAVAILABLE",
    SESSION_CREATE: "REHEARSAL_SESSION_CREATE_FAILED",
    REFERENCE_ADMISSION: "REHEARSAL_REFERENCE_ADMISSION_FAILED",
    EMAIL_REFERENCE_RESOLUTION: "REHEARSAL_CREDENTIAL_RESOLUTION_FAILED",
    PASSWORD_REFERENCE_RESOLUTION: "REHEARSAL_CREDENTIAL_RESOLUTION_FAILED",
    LOGIN_NAVIGATION: "REHEARSAL_LOGIN_NAVIGATION_FAILED",
    LOGIN_GROUNDING: "REHEARSAL_LOGIN_GROUNDING_FAILED",
    LOGIN_DISPATCH: "REHEARSAL_LOGIN_DISPATCH_FAILED",
    AUTHENTICATED_READINESS: "REHEARSAL_AUTH_READINESS_FAILED",
    TARGET_CREDENTIAL_PAIR_REVALIDATION: "REHEARSAL_TARGET_CREDENTIAL_PAIR_INVALID",
    CREDENTIAL_PAGE_NAVIGATION: "REHEARSAL_CREDENTIAL_PAGE_NAVIGATION_FAILED",
  };
  return specific[stage] ?? `REHEARSAL_${stage}_FAILED`;
}
export function safeGroundingDiagnostic(error: unknown): SafeGroundingDiagnostic | undefined {
  if (!error || typeof error !== "object" || !("diagnostic" in error)) return undefined;
  const value = (error as { diagnostic?: Record<string, unknown> }).diagnostic;
  if (!value || typeof value !== "object") return undefined;
  const numeric = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0);
  const observation =
    value.observation && typeof value.observation === "object"
      ? (value.observation as Record<string, unknown>)
      : {};
  const scope =
    value.scope && typeof value.scope === "object" ? (value.scope as Record<string, unknown>) : {};
  const categorical = (item: unknown): item is "yes" | "no" | "unknown" =>
    item === "yes" || item === "no" || item === "unknown";
  const signatures = Array.isArray(value.rejectedCapabilitySignatures)
    ? value.rejectedCapabilitySignatures.flatMap((item): SafeRejectedCapabilitySignature[] => {
        if (!item || typeof item !== "object") return [];
        const signature = item as Record<string, unknown>;
        if (
          !Number.isInteger(signature.count) ||
          (signature.count as number) < 1 ||
          !["input", "textarea", "other"].includes(signature.nativeKindClass as string) ||
          !["textbox", "other"].includes(signature.computedRoleClass as string) ||
          !categorical(signature.visible) ||
          !categorical(signature.enabled) ||
          !categorical(signature.readonly) ||
          !categorical(signature.acceptsText) ||
          !categorical(signature.focusable) ||
          !categorical(signature.editable)
        )
          return [];
        return [
          {
            count: signature.count as number,
            nativeKindClass:
              signature.nativeKindClass as SafeRejectedCapabilitySignature["nativeKindClass"],
            computedRoleClass:
              signature.computedRoleClass as SafeRejectedCapabilitySignature["computedRoleClass"],
            visible: signature.visible,
            enabled: signature.enabled,
            readonly: signature.readonly,
            acceptsText: signature.acceptsText,
            focusable: signature.focusable,
            editable: signature.editable,
          },
        ];
      })
    : [];
  return {
    candidateCount: numeric("candidateCount"),
    eligibleCount: numeric("eligibleCount"),
    confidence: numeric("confidence"),
    confidenceMargin: numeric("confidenceMargin"),
    rejectedConstraints: Array.isArray(value.rejectedConstraints)
      ? value.rejectedConstraints.filter(
          (item): item is string =>
            typeof item === "string" && /^[a-z_]+(?::[a-z_]+)?$/i.test(item),
        )
      : [],
    scopeKind: typeof scope.kind === "string" ? scope.kind : "unknown",
    observationStatus: typeof observation.status === "string" ? observation.status : "unknown",
    ...(typeof observation.phase === "string" ? { observationPhase: observation.phase } : {}),
    ...(typeof observation.reasonCode === "string" &&
    /^[A-Z][A-Z0-9_]+$/i.test(observation.reasonCode)
      ? { observationReasonCode: observation.reasonCode }
      : {}),
    rejectedCapabilitySignatures: signatures,
  };
}
export function emptyNativePraxisTelemetry(): NativePraxisTelemetry {
  return {
    nativeAttempted: "no",
    nativeSucceeded: "no",
    nativeFailureCode: "unavailable",
    praxisFallbackAttempted: "no",
    praxisSucceeded: "no",
    praxisFailureCode: "unavailable",
  };
}
export async function resolveNativeThenPraxis<T>(
  native: () => Promise<T>,
  praxis: () => Promise<T>,
  telemetry = emptyNativePraxisTelemetry(),
): Promise<T> {
  telemetry.nativeAttempted = "yes";
  try {
    const result = await native();
    telemetry.nativeSucceeded = "yes";
    return result;
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : error instanceof Error
          ? error.message
          : String(error);
    if (
      !["NATIVE_TARGET_NOT_FOUND", "NATIVE_TARGET_AMBIGUOUS", "NATIVE_SCOPE_UNSAFE"].includes(code)
    )
      throw error;
    telemetry.nativeFailureCode = code;
    telemetry.praxisFallbackAttempted = "yes";
    try {
      const result = await praxis();
      telemetry.praxisSucceeded = "yes";
      return result;
    } catch (praxisError) {
      telemetry.praxisFailureCode = safeFailureCode("EMAIL_GROUNDING", praxisError);
      throw praxisError;
    }
  }
}
export function loginGroundingUnavailable(telemetry: StageTelemetry) {
  return (["EMAIL_GROUNDING", "PASSWORD_GROUNDING", "LOGIN_GROUNDING"] as const).some(
    (stage) => telemetry[stage].status === "failed" || telemetry[stage].status === "timed_out",
  );
}
function equivalentOriginSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}
export function formatEmailGroundingDiagnostics(telemetry: StageTelemetry): string[] {
  const resolution = telemetry.EMAIL_GROUNDING.resolution ?? emptyNativePraxisTelemetry();
  const grounding = telemetry.EMAIL_GROUNDING.grounding;
  return [
    `emailGrounding.nativeAttempted: ${resolution.nativeAttempted}`,
    `emailGrounding.nativeSucceeded: ${resolution.nativeSucceeded}`,
    `emailGrounding.nativeFailureCode: ${resolution.nativeFailureCode}`,
    `emailGrounding.praxisFallbackAttempted: ${resolution.praxisFallbackAttempted}`,
    `emailGrounding.praxisSucceeded: ${resolution.praxisSucceeded}`,
    `emailGrounding.praxisFailureCode: ${resolution.praxisFailureCode}`,
    `emailGrounding.praxisCandidateCount: ${grounding?.candidateCount ?? 0}`,
    `emailGrounding.praxisEligibleCount: ${grounding?.eligibleCount ?? 0}`,
    `emailGrounding.rejectedCapabilitySignatures: ${JSON.stringify(grounding?.rejectedCapabilitySignatures ?? [])}`,
    `emailGrounding.rejectedConstraints: ${JSON.stringify(grounding?.rejectedConstraints ?? [])}`,
  ];
}

type Tri = "yes" | "no" | "undetermined";
type Output = {
  credentialPairProvenanceResolved: "yes" | "no";
  historicalApplicationProvenanceResolved: "yes";
  credentialPageResolved: "yes" | "no";
  revokeCandidateCount: number;
  candidateContainerKinds: string[];
  candidateContainersDistinguishable: "yes" | "no";
  potentialPublicMetadataClasses: string[];
  safePublicRecordDiscriminator: "available" | "unavailable" | "unknown";
  discriminatorUnique: "unique" | "duplicate" | "unavailable" | "unknown";
  intendedCredentialToExternalRecordBinding: "proven" | "not_proven";
  namedSemanticScopeSufficient: Tri;
  existingOtherPraxisPrimitiveSufficient: Tri;
  praxisExtensionRequired: Tri;
  revokeMutationIntentCount: 0;
  revokeBrowserDispatchCount: 0;
  historicalLifecycleBindingMissing: "yes" | "no";
  historicalRiskMisclassified: "yes" | "no";
  providerRejectedCredentials: "yes" | "no" | "not_proven";
  result:
    | "SAFE_TO_DESIGN"
    | "INSUFFICIENT_SAFE_IDENTITY"
    | "AUTHENTICATION_UNAVAILABLE"
    | "LOGIN_TARGET_UNAVAILABLE"
    | "CREDENTIAL_PAGE_UNAVAILABLE";
};

const output: Output = {
  credentialPairProvenanceResolved: "no",
  historicalApplicationProvenanceResolved: "yes",
  credentialPageResolved: "no",
  revokeCandidateCount: 0,
  candidateContainerKinds: [],
  candidateContainersDistinguishable: "no",
  potentialPublicMetadataClasses: [],
  safePublicRecordDiscriminator: "unknown",
  discriminatorUnique: "unknown",
  intendedCredentialToExternalRecordBinding: "not_proven",
  namedSemanticScopeSufficient: "undetermined",
  existingOtherPraxisPrimitiveSufficient: "undetermined",
  praxisExtensionRequired: "undetermined",
  revokeMutationIntentCount: 0,
  revokeBrowserDispatchCount: 0,
  historicalLifecycleBindingMissing: "yes",
  historicalRiskMisclassified: "yes",
  providerRejectedCredentials: "not_proven",
  result: "AUTHENTICATION_UNAVAILABLE",
};

const target = (
  concept: string,
  role: "textbox" | "button",
  fact: "name" | "placeholder",
  value: string,
  risk: InteractionTargetIntent["risk"],
): InteractionTargetIntent => ({
  concept,
  requiredCapabilities:
    fact === "placeholder"
      ? ["accepts_text", "focusable", "editable"]
      : ["focusable", "pointer_activatable"],
  preferredEvidence: {
    roles: [role],
    names: fact === "name" ? [value] : [],
    labels: [],
    descriptions: [],
    placeholders: fact === "placeholder" ? [value] : [],
    inputTypes: [],
    testIds: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk,
  confidence: { requiredFamilies: [] },
  matching: "exact",
});
const revokeGroundingIntent = (
  scope: InteractionTargetIntent["scope"],
  relations: InteractionTargetIntent["relations"] = [],
): InteractionTargetIntent => ({
  concept: "observe revoke candidate",
  requiredCapabilities: ["focusable", "pointer_activatable"],
  preferredEvidence: {
    roles: ["button"],
    names: ["Revoke", "Revoke credential"],
    labels: [],
    descriptions: [],
    placeholders: [],
    inputTypes: [],
    testIds: [],
  },
  scope,
  relations,
  prohibited: ["hidden", "disabled"],
  risk: "destructive",
  confidence: { requiredFamilies: [] },
  matching: "exact",
});
export type SafeDescriptor = {
  kind: string;
  components: Array<{ class: string; value: string; independentlyPublic: boolean }>;
  potentialMetadataClasses?: string[];
};
const protectedLooking = (value: string) =>
  /client\s*id|secret|api\s*key|token|masked|\*{3,}|[0-9a-f]{8}-[0-9a-f-]{27,}|\b[A-Za-z0-9_-]{24,}\b/i.test(
    value,
  );
export function descriptorFromAccessibilitySnapshot(
  kind: string,
  snapshot: string,
): SafeDescriptor {
  const normalized = snapshot.normalize("NFKC");
  const components: SafeDescriptor["components"] = [];
  const potentialMetadataClasses = new Set<string>();
  const admit = (metadataClass: string, value: string) => {
    const safe = value.replace(/^['"]|['"]$/g, "").trim();
    potentialMetadataClasses.add(metadataClass);
    if (safe && !protectedLooking(safe))
      components.push({
        class: metadataClass,
        value: safe.toLowerCase(),
        independentlyPublic: true,
      });
  };
  for (const line of normalized.split("\n")) {
    const text = line
      .replace(/^\s*-?\s*(?:text|heading|status|time)?\s*:?[ ]*/i, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();
    const created = text.match(/\b(?:created|issued)(?:\s+(?:at|on))?\s*:?\s*(.+)$/i);
    if (created) admit("creation_time", created[1]!);
    const status = text.match(/\bstatus\s*:?\s*(active|revoked|inactive)\b/i);
    if (status) admit("status", status[1]!);
    const label = text.match(/\bcredential\s+(?:label|name)\s*:?\s*(.+)$/i);
    if (label) admit("provider_record_label", label[1]!);
  }
  return { kind, components, potentialMetadataClasses: [...potentialMetadataClasses].sort() };
}
export function analyzeDescriptors(first: SafeDescriptor[], second: SafeDescriptor[]) {
  const canonical = (descriptor: SafeDescriptor) =>
    descriptor.components.every((item) => item.independentlyPublic) && descriptor.components.length
      ? `${descriptor.kind}|${descriptor.components
          .map((item) => `${item.class}:${item.value}`)
          .sort()
          .join("|")}`
      : undefined;
  const a = first.map(canonical);
  const b = second.map(canonical);
  const available = a.length > 0 && a.every((item): item is string => Boolean(item));
  const stable =
    available &&
    a.length === b.length &&
    [...a].sort().every((item, index) => item === [...b].sort()[index]);
  const unique = stable && new Set(a).size === a.length;
  return { available, stable, unique, distinguishable: unique };
}

export function credentialRouteMatches(actual: string, expected = EXPECTED.credentialUrl) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.origin === e.origin && a.pathname.replace(/\/$/, "") === e.pathname.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export type RevokeCandidateSet = {
  first(): { waitFor(input: { state: "visible"; timeout: number }): Promise<void> };
  count(): Promise<number>;
  nth(index: number): Locator;
};
export async function settleVisibleRevokeCandidates(
  candidates: RevokeCandidateSet,
  timeoutMs = 5_000,
) {
  try {
    await candidates.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    if (!(error instanceof playwrightErrors.TimeoutError)) throw error;
  }
  const visible: Locator[] = [];
  for (let index = 0, count = await candidates.count(); index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  return visible;
}

async function inspectCandidates(page: Page) {
  const candidates = page.getByRole("button", { name: /^(Revoke|Revoke credential)$/i });
  const visibleCandidates = await settleVisibleRevokeCandidates(candidates);
  const count = visibleCandidates.length;
  const observations: SafeDescriptor[] = [];
  for (const candidate of visibleCandidates)
    observations.push(await observeContainer(page, candidate));
  await page.waitForTimeout(350);
  const second = await Promise.all(
    visibleCandidates.map((candidate) => observeContainer(page, candidate)),
  );
  const analysis = analyzeDescriptors(observations, second);
  const kinds = [...new Set(observations.map((item) => item.kind))].sort();
  const potentialMetadataClasses = [
    ...new Set(observations.flatMap((item) => item.potentialMetadataClasses ?? [])),
  ].sort();
  return { count, kinds, observations, analysis, potentialMetadataClasses };
}

async function observeContainer(page: Page, candidate: Locator): Promise<SafeDescriptor> {
  const semanticContainers: Array<{ role: Parameters<Page["getByRole"]>[0]; kind: string }> = [
    { role: "row", kind: "row" },
    { role: "listitem", kind: "listitem" },
    { role: "article", kind: "article" },
    { role: "region", kind: "region" },
    { role: "group", kind: "field_group" },
    { role: "form", kind: "form" },
    { role: "table", kind: "table" },
  ];
  for (const item of semanticContainers) {
    const containers = page.getByRole(item.role).filter({ has: candidate });
    if ((await containers.count()) === 1)
      return descriptorFromAccessibilitySnapshot(
        item.kind,
        await containers.ariaSnapshot({ timeout: 2_000 }),
      );
  }
  return { kind: "other", components: [], potentialMetadataClasses: [] };
}

export type PreparedSession = {
  id: string;
  state: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  flowDraftId: string;
  agentSessionId: string;
  idempotencyKey: string;
  correlationId: string;
  protectedAllowlist: string[];
};
export function validatePreparedSession(
  value: PreparedSession,
  expectedId: string,
): PreparedSession {
  const expectedReferences = [EXPECTED.loginEmailReference, EXPECTED.loginPasswordReference];
  const references = new Set(value.protectedAllowlist);
  if (
    value.id !== expectedId ||
    value.state !== "active" ||
    value.projectId !== EXPECTED.projectId ||
    value.environmentId !== EXPECTED.environmentId ||
    value.missionId !== EXPECTED.missionId ||
    value.objectiveId !== EXPECTED.objectiveId ||
    value.flowDraftId !== EXPECTED.flowDraftId ||
    value.agentSessionId !== EXPECTED.agentSessionId ||
    value.idempotencyKey !== EXPECTED.idempotencyKey ||
    value.correlationId !== EXPECTED.correlationId ||
    value.protectedAllowlist.length !== expectedReferences.length ||
    references.size !== expectedReferences.length ||
    expectedReferences.some((reference) => !references.has(reference))
  )
    throw { response: { code: "REHEARSAL_PREPARED_SESSION_MISMATCH" } };
  return value;
}
export type PreparationDependencies = {
  loadEnvironmentPolicy(): Promise<ExecutionPolicy>;
  create?(input: {
    initialProtectedReferenceIds: string[];
    allowedOrigins: string[];
  }): Promise<{ id: string; replayed: boolean }>;
  resolvePreparedSession(sessionId: string): Promise<PreparedSession>;
  loadRuntimePolicy(sessionId: string): Promise<ExecutionPolicy>;
  admit(sessionId: string, reference: string, kind: "email" | "password"): Promise<void>;
  resolve(sessionId: string, reference: string): Promise<string>;
  revalidateTargetPair(): Promise<void>;
  launchBrowser(): Promise<void>;
  runLive?: (input: {
    email: string;
    password: string;
    policy: ExecutionPolicy;
    stage<T>(name: StageName, work: () => Promise<T>): Promise<T>;
    recordResolution(name: StageName, resolution: NativePraxisTelemetry): void;
  }) => Promise<void>;
};
export type RehearsalMode =
  | { mode: "prepare"; initialProtectedReferenceIds?: string[] }
  | { mode: "live"; preparedSessionId: string };
export async function runPreparation(deps: PreparationDependencies, options: RehearsalMode) {
  const telemetry = emptyTelemetry();
  let sessionId: string | undefined;
  let runtimePolicy: ExecutionPolicy | undefined;
  let preparationDisposition: "created" | "replayed" | undefined;
  let email = "";
  let password = "";
  const redactor = new SecretRedactor();
  const execute = async <T>(stage: StageName, work: () => Promise<T>) => {
    telemetry[stage] = { ...telemetry[stage], status: "started" };
    try {
      const result = await work();
      telemetry[stage] = { ...telemetry[stage], status: "succeeded" };
      return result;
    } catch (error) {
      const code = safeFailureCode(stage, error);
      const grounding = safeGroundingDiagnostic(error);
      telemetry[stage] = {
        ...telemetry[stage],
        status: /TIMED_OUT$/.test(code) ? "timed_out" : "failed",
        code,
        ...(grounding ? { grounding } : {}),
      };
      throw error;
    }
  };
  try {
    const environmentPolicy = await execute(
      "ENVIRONMENT_POLICY_RESOLUTION",
      deps.loadEnvironmentPolicy,
    );
    if (options.mode === "prepare") {
      if (!deps.create) throw { response: { code: "REHEARSAL_SESSION_CREATOR_UNAVAILABLE" } };
      const created = await execute("SESSION_CREATE", () =>
        deps.create!({
          initialProtectedReferenceIds: options.initialProtectedReferenceIds ?? [
            EXPECTED.loginEmailReference,
            EXPECTED.loginPasswordReference,
          ],
          allowedOrigins: environmentPolicy.allowedOrigins,
        }),
      );
      sessionId = created.id;
      preparationDisposition = created.replayed ? "replayed" : "created";
    } else {
      sessionId = options.preparedSessionId;
    }
    await execute("PREPARED_SESSION_RESOLUTION", async () => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          sessionId!,
        )
      )
        throw { response: { code: "REHEARSAL_PREPARED_SESSION_ID_INVALID" } };
      return validatePreparedSession(await deps.resolvePreparedSession(sessionId!), sessionId!);
    });
    runtimePolicy = await execute("RUNTIME_POLICY_RESOLUTION", async () => {
      const policy = await deps.loadRuntimePolicy(sessionId!);
      if (
        !equivalentOriginSet(policy.allowedOrigins, environmentPolicy.allowedOrigins) ||
        !equivalentOriginSet(policy.trustedScriptOrigins, environmentPolicy.trustedScriptOrigins)
      )
        throw { response: { code: "REHEARSAL_RUNTIME_POLICY_MISMATCH" } };
      return policy;
    });
    await execute("REFERENCE_ADMISSION", async () => {
      await deps.admit(sessionId!, EXPECTED.loginEmailReference, "email");
      await deps.admit(sessionId!, EXPECTED.loginPasswordReference, "password");
    });
    email = await execute("EMAIL_REFERENCE_RESOLUTION", () =>
      deps.resolve(sessionId!, EXPECTED.loginEmailReference),
    );
    redactor.add(email);
    password = await execute("PASSWORD_REFERENCE_RESOLUTION", () =>
      deps.resolve(sessionId!, EXPECTED.loginPasswordReference),
    );
    redactor.add(password);
    await execute("TARGET_CREDENTIAL_PAIR_REVALIDATION", deps.revalidateTargetPair);
    if (options.mode === "prepare")
      return {
        sessionId,
        preparationDisposition,
        telemetry,
        emailResolved: true,
        passwordResolved: true,
        browserLaunchAttempted: false,
        safeCode: "PREPARATION_COMPLETE",
      };
    await execute("BROWSER_LAUNCH", deps.launchBrowser);
    if (!deps.runLive) throw new Error("REHEARSAL_LIVE_CONTINUATION_UNAVAILABLE");
    await deps.runLive({
      email,
      password,
      policy: runtimePolicy,
      stage: execute,
      recordResolution: (name, resolution) => {
        telemetry[name] = { ...telemetry[name], resolution };
      },
    });
    return {
      sessionId,
      preparationDisposition,
      telemetry,
      emailResolved: true,
      passwordResolved: true,
      browserLaunchAttempted: true,
      safeCode: "LIVE_INSPECTION_COMPLETE",
    };
  } catch {
    const failure = STAGES.find(
      (stage) => telemetry[stage].status === "failed" || telemetry[stage].status === "timed_out",
    );
    return {
      sessionId,
      preparationDisposition,
      telemetry,
      emailResolved: telemetry.EMAIL_REFERENCE_RESOLUTION.status === "succeeded",
      passwordResolved: telemetry.PASSWORD_REFERENCE_RESOLUTION.status === "succeeded",
      browserLaunchAttempted: telemetry.BROWSER_LAUNCH.status !== "not_started",
      safeCode: failure ? telemetry[failure].code! : "REHEARSAL_UNKNOWN_FAILURE",
    };
  } finally {
    email = "";
    password = "";
  }
}

function protectedFillIntent(
  intentId: string,
  reference: string,
  placeholder: string,
): MissionAuthoringIntent {
  return {
    intentId,
    objectiveId: EXPECTED.objectiveId,
    flowDraftId: EXPECTED.flowDraftId,
    action: {
      kind: "fill",
      target: { concept: intentId, role: "textbox", placeholder, exact: true },
      protectedReferenceId: reference,
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "authentication" },
    protectedInputReferences: [reference],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const prepare = argv.includes("--prepare");
  const live = argv.includes("--live");
  if (prepare === live) throw new Error("EXACTLY_ONE_REHEARSAL_MODE_REQUIRED");
  const preparedSessionIndex = argv.indexOf("--prepared-session");
  const preparedSessionId = preparedSessionIndex >= 0 ? argv[preparedSessionIndex + 1] : undefined;
  if (live && !preparedSessionId) throw { code: "REHEARSAL_PREPARED_SESSION_REQUIRED" };
  if (prepare && preparedSessionIndex >= 0)
    throw { code: "REHEARSAL_PREPARED_SESSION_NOT_ALLOWED_DURING_PREPARATION" };
  const database = new Database();
  const sessions = new AdaptiveSessionRepository(database);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  const common = {
    loadEnvironmentPolicy: async () => {
      const result = await database.query<{ policy: unknown; baseOrigin: string }>(
        `SELECT environment.policy,environment.base_origin AS "baseOrigin"
           FROM environments environment
           JOIN projects project ON project.id=environment.project_id
          WHERE project.id=$1 AND environment.id=$2`,
        [EXPECTED.projectId, EXPECTED.environmentId],
      );
      if (result.rowCount !== 1)
        throw { response: { code: "REHEARSAL_ENVIRONMENT_POLICY_UNAVAILABLE" } };
      const policy = executionPolicySchema.parse(result.rows[0]!.policy);
      if (!policy.allowedOrigins.includes(new URL(result.rows[0]!.baseOrigin).origin))
        throw { response: { code: "REHEARSAL_ENVIRONMENT_POLICY_INVALID" } };
      return policy;
    },
    loadRuntimePolicy: async (sessionId) => {
      const runtime = await sessions.runtimeContextFor(sessionId);
      if (
        runtime.projectId !== EXPECTED.projectId ||
        runtime.environmentId !== EXPECTED.environmentId
      )
        throw { response: { code: "REHEARSAL_RUNTIME_POLICY_OWNER_MISMATCH" } };
      return runtime.policy;
    },
    resolvePreparedSession: async (sessionId) => {
      const prepared = await database.query<PreparedSession>(
        `SELECT id,state,project_id AS "projectId",environment_id AS "environmentId",mission_id AS "missionId",objective_id AS "objectiveId",
                flow_draft_id AS "flowDraftId",agent_session_id AS "agentSessionId",idempotency_key AS "idempotencyKey",
                correlation_id AS "correlationId",protected_reference_allowlist AS "protectedAllowlist"
           FROM adaptive_sessions WHERE id=$1`,
        [sessionId],
      );
      if (prepared.rowCount !== 1)
        throw { response: { code: "REHEARSAL_PREPARED_SESSION_UNAVAILABLE" } };
      return prepared.rows[0]!;
    },
    admit: (sessionId, reference, kind) =>
      sessions.validateIntentAdmission({
        sessionId,
        intent: protectedFillIntent(
          `vitract-rehearsal-${kind}`,
          reference,
          kind === "email" ? "Enter your email" : "Enter your password",
        ),
      }),
    resolve: (sessionId, reference) => sessions.resolveCredential(sessionId, reference),
    revalidateTargetPair: async () => {
      const pair = await database.query<{ id: string }>(
        `SELECT credential.id::text
           FROM project_credentials credential
           JOIN protected_operations operation ON operation.id=credential.origin_protected_operation_id
           JOIN environments environment ON environment.id=$4 AND environment.project_id=credential.project_id
          WHERE credential.id=ANY($1::uuid[]) AND credential.project_id=$2
            AND credential.origin_protected_operation_id=$3
            AND credential.security_status='active' AND credential.deleted_at IS NULL
            AND environment.secret_refs ? credential.id::text`,
        [
          [EXPECTED.clientIdReference, EXPECTED.clientSecretReference],
          EXPECTED.projectId,
          EXPECTED.originProtectedOperationId,
          EXPECTED.environmentId,
        ],
      );
      if (pair.rowCount !== 2 || new Set(pair.rows.map((row) => row.id)).size !== 2)
        throw { response: { code: "REHEARSAL_TARGET_CREDENTIAL_PAIR_INVALID" } };
    },
    launchBrowser: async () => {
      browser = await chromium.launch({
        headless: true,
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      page = await browser.newPage();
    },
    runLive: async ({
      email,
      password,
      policy,
      stage,
      recordResolution,
    }: Parameters<NonNullable<PreparationDependencies["runLive"]>>[0]) => {
      if (!page) throw new Error("REHEARSAL_BROWSER_PAGE_UNAVAILABLE");
      await stage("LOGIN_NAVIGATION", async () => {
        await navigateAndWaitNative(
          page!,
          EXPECTED.loginUrl,
          policy.allowedOrigins,
          30_000,
          policy.trustedScriptOrigins ?? [],
        );
      });
      type RehearsalTarget = { locator: Locator; revalidate(): Promise<void> };
      const nativeTarget = async (intent: InteractionTargetIntent): Promise<RehearsalTarget> => {
        const locator = await resolveTargetLocator(page!, intent);
        return {
          locator,
          revalidate: async () => {
            await locator.waitFor({ state: "visible", timeout: 1_000 });
          },
        };
      };
      const praxisTarget = (intent: InteractionTargetIntent): Promise<RehearsalTarget> =>
        resolveTarget(page!, intent, { allowedOrigins: policy.allowedOrigins });
      let emailTarget: RehearsalTarget;
      await stage("EMAIL_GROUNDING", async () => {
        const intent = target(
          "login email",
          "textbox",
          "placeholder",
          "Enter your email",
          "authentication",
        );
        const resolution = emptyNativePraxisTelemetry();
        try {
          emailTarget = await resolveNativeThenPraxis(
            () => nativeTarget(intent),
            () => praxisTarget(intent),
            resolution,
          );
        } finally {
          recordResolution("EMAIL_GROUNDING", resolution);
        }
      });
      await stage("EMAIL_FILL", async () => {
        await emailTarget!.revalidate();
        await emailTarget!.locator.fill(email, { timeout: 10_000 });
      });
      let passwordTarget: RehearsalTarget;
      await stage("PASSWORD_GROUNDING", async () => {
        const intent = target(
          "login password",
          "textbox",
          "placeholder",
          "Enter your password",
          "authentication",
        );
        const resolution = emptyNativePraxisTelemetry();
        try {
          passwordTarget = await resolveNativeThenPraxis(
            () => nativeTarget(intent),
            () => praxisTarget(intent),
            resolution,
          );
        } finally {
          recordResolution("PASSWORD_GROUNDING", resolution);
        }
      });
      await stage("PASSWORD_FILL", async () => {
        await passwordTarget!.revalidate();
        await passwordTarget!.locator.fill(password, { timeout: 10_000 });
      });
      let loginTarget: RehearsalTarget;
      await stage("LOGIN_GROUNDING", async () => {
        const intent = target("login", "button", "name", "Login", "authentication");
        const resolution = emptyNativePraxisTelemetry();
        try {
          loginTarget = await resolveNativeThenPraxis(
            () => nativeTarget(intent),
            () => praxisTarget(intent),
            resolution,
          );
        } finally {
          recordResolution("LOGIN_GROUNDING", resolution);
        }
      });
      await stage("LOGIN_DISPATCH", async () => {
        await loginTarget!.revalidate();
        await loginTarget!.locator.click({ timeout: 10_000 });
      });
      await stage("AUTHENTICATED_READINESS", async () => {
        await page!.waitForURL(
          (url) => url.origin === "https://preview.vitract.com" && !url.pathname.endsWith("/login"),
          { timeout: 30_000 },
        );
      });
      // No durable provider endpoint is known. Readiness is authoritative; response
      // correlation remains explicitly observational instead of blocking success.
      resultProviderObservation(stage);
      await stage("CREDENTIAL_PAGE_NAVIGATION", async () => {
        await navigateAndWaitNative(
          page!,
          EXPECTED.credentialUrl,
          policy.allowedOrigins,
          30_000,
          policy.trustedScriptOrigins ?? [],
        );
        if (!credentialRouteMatches(page!.url()))
          throw new Error("REHEARSAL_CREDENTIAL_PAGE_NAVIGATION_FAILED");
      });
      await stage("CREDENTIAL_PAGE_OBSERVATION", async () => {
        const observed = await inspectCandidates(page!);
        output.revokeCandidateCount = observed.count;
        output.candidateContainerKinds = observed.kinds;
        output.potentialPublicMetadataClasses = observed.potentialMetadataClasses;
        output.candidateContainersDistinguishable = observed.analysis.distinguishable
          ? "yes"
          : "no";
        output.safePublicRecordDiscriminator =
          observed.analysis.available && observed.analysis.stable ? "available" : "unavailable";
        output.discriminatorUnique = !observed.analysis.available
          ? "unavailable"
          : observed.analysis.unique
            ? "unique"
            : "duplicate";
        output.intendedCredentialToExternalRecordBinding = "not_proven";
        let namedResolved = false;
        let relationResolved = false;
        if (observed.analysis.distinguishable) {
          for (const descriptor of observed.observations) {
            const anchor = descriptor.components[0]?.value;
            if (!anchor) continue;
            const scopeKind =
              descriptor.kind === "row"
                ? "row"
                : ["section", "region", "form", "field_group"].includes(descriptor.kind)
                  ? descriptor.kind
                  : undefined;
            if (scopeKind)
              namedResolved ||= await resolveTarget(
                page!,
                revokeGroundingIntent({ kind: scopeKind as "row", name: anchor }),
                { allowedOrigins: policy.allowedOrigins },
              ).then(
                () => true,
                () => false,
              );
            relationResolved ||= await resolveTarget(
              page!,
              revokeGroundingIntent({ kind: "page" }, [{ kind: "same_boundary", name: anchor }]),
              { allowedOrigins: policy.allowedOrigins },
            ).then(
              () => true,
              () => false,
            );
          }
        }
        // Existing primitives may resolve a row, but without the issuance bridge
        // they cannot resolve the intended protected record.
        const bindingProven =
          (output.intendedCredentialToExternalRecordBinding as string) === "proven";
        output.namedSemanticScopeSufficient = namedResolved && bindingProven ? "yes" : "no";
        output.existingOtherPraxisPrimitiveSufficient =
          relationResolved && bindingProven ? "yes" : "no";
        output.praxisExtensionRequired = "undetermined";
        output.credentialPageResolved = "yes";
        output.result = "INSUFFICIENT_SAFE_IDENTITY";
      });
    },
  } satisfies Omit<PreparationDependencies, "create">;
  const result = prepare
    ? await runPreparation(
        {
          ...common,
          create: (input) =>
            sessions.create(null, {
              projectId: EXPECTED.projectId,
              environmentId: EXPECTED.environmentId,
              missionId: EXPECTED.missionId,
              objectiveId: EXPECTED.objectiveId,
              flowDraftId: EXPECTED.flowDraftId,
              agentSessionId: EXPECTED.agentSessionId,
              objective: "vitract-revoke-target-rehearsal-v3-read-only",
              allowedOrigins: input.allowedOrigins,
              idempotencyKey: EXPECTED.idempotencyKey,
              correlationId: EXPECTED.correlationId,
              initialProtectedReferenceIds: input.initialProtectedReferenceIds,
            }),
        },
        { mode: "prepare" },
      )
    : await runPreparation(common, { mode: "live", preparedSessionId: preparedSessionId! });
  output.credentialPairProvenanceResolved =
    result.telemetry.TARGET_CREDENTIAL_PAIR_REVALIDATION.status === "succeeded" ? "yes" : "no";
  if (loginGroundingUnavailable(result.telemetry)) {
    output.result = "LOGIN_TARGET_UNAVAILABLE";
    output.providerRejectedCredentials = "not_proven";
  }
  await browser?.close().catch(() => undefined);
  await database.onModuleDestroy();
  process.stdout.write(
    [
      `preparationDisposition: ${result.preparationDisposition ?? "unavailable"}`,
      `preparedSessionResolved: ${result.sessionId ? "yes" : "no"}`,
      `preparedSessionId: ${result.sessionId ?? "unavailable"}`,
      `environmentPolicyResolved: ${result.telemetry.ENVIRONMENT_POLICY_RESOLUTION.status === "succeeded" ? "yes" : "no"}`,
      `runtimePolicyEquivalent: ${result.telemetry.RUNTIME_POLICY_RESOLUTION.status === "succeeded" ? "yes" : "no"}`,
      `loginRefsAllowlisted: ${result.telemetry.REFERENCE_ADMISSION.status === "succeeded" ? "yes" : "no"}`,
      `loginRefsAdmissionAccepted: ${result.telemetry.REFERENCE_ADMISSION.status === "succeeded" ? "yes" : "no"}`,
      `emailCredentialResolutionSucceeded: ${result.emailResolved ? "yes" : "no"}`,
      `passwordCredentialResolutionSucceeded: ${result.passwordResolved ? "yes" : "no"}`,
      `browserLaunchAttempted: ${result.browserLaunchAttempted ? "yes" : "no"}`,
      ...formatObservationOutput(),
      ...formatEmailGroundingDiagnostics(result.telemetry),
      `result: ${result.safeCode}`,
      ...STAGES.flatMap((stage) => [
        `stage.${stage}: ${result.telemetry[stage].status}${result.telemetry[stage].code ? `:${result.telemetry[stage].code}` : ""}`,
        ...(result.telemetry[stage].resolution
          ? [`stage.${stage}.resolution: ${JSON.stringify(result.telemetry[stage].resolution)}`]
          : []),
        ...(result.telemetry[stage].grounding
          ? [`stage.${stage}.grounding: ${JSON.stringify(result.telemetry[stage].grounding)}`]
          : []),
      ]),
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    process.stderr.write(`${safeFailureCode("SESSION_CREATE", error)}\n`);
    process.exitCode = 1;
  });

/* Historical output formatter retained for the future observation continuation. */
export function formatObservationOutput(overrides: Partial<Output> = {}) {
  const value = { ...output, ...overrides };
  return [
    `credentialPairProvenanceResolved: ${value.credentialPairProvenanceResolved}`,
    `historicalApplicationProvenanceResolved: ${value.historicalApplicationProvenanceResolved}`,
    `credentialPageResolved: ${value.credentialPageResolved}`,
    `revokeCandidateCount: ${value.revokeCandidateCount}`,
    `candidateContainerKinds: [${value.candidateContainerKinds.join(",")}]`,
    `potentialPublicMetadataClasses: [${value.potentialPublicMetadataClasses.join(",")}]`,
    `candidateContainersDistinguishable: ${value.candidateContainersDistinguishable}`,
    `safePublicRecordDiscriminator: ${value.safePublicRecordDiscriminator}`,
    `discriminatorUnique: ${value.discriminatorUnique}`,
    `intendedCredentialToExternalRecordBinding: ${value.intendedCredentialToExternalRecordBinding}`,
    `namedSemanticScopeSufficient: ${value.namedSemanticScopeSufficient}`,
    `existingOtherPraxisPrimitiveSufficient: ${value.existingOtherPraxisPrimitiveSufficient}`,
    `praxisExtensionRequired: ${value.praxisExtensionRequired}`,
    `revokeMutationIntentCount: ${value.revokeMutationIntentCount}`,
    `revokeBrowserDispatchCount: ${value.revokeBrowserDispatchCount}`,
    `historicalLifecycleBindingMissing: ${value.historicalLifecycleBindingMissing}`,
    `historicalRiskMisclassified: ${value.historicalRiskMisclassified}`,
    `result: ${value.result}`,
    `providerRejectedCredentials: ${value.providerRejectedCredentials}`,
  ];
}

function resultProviderObservation(_stage: unknown) {
  // Intentionally no request waiter: authenticated readiness owns success.
}
