import { createHash, randomUUID } from "node:crypto";

import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type {
  MissionAuthoringIntent,
  PreparedFlowAuthoring,
  ReservePreparedProtectedOperationInput,
  ResumePreparedProtectedOperationInput,
} from "@scry/contracts";

import type { Principal } from "../../auth/index.js";
import { Database } from "../../infrastructure/index.js";
import { ProjectConfigurationRepository } from "../../access/repositories/project-configuration.repository.js";
import { MissionFlowAuthoringService } from "../mission-flow-authoring.service.js";

const VITRACT_TRUSTED_SCRIPT_ORIGINS = [
  "https://static.cloudflareinsights.com",
  "https://js.stripe.com",
  "https://maps.googleapis.com",
] as const;

export type PrepareVitractCredentialIssuanceInput = Readonly<{
  projectId: string;
  environmentId: string;
  loginEmailReferenceId: string;
  loginPasswordReferenceId: string;
  applicationResourceScope: string;
  credentialName: string;
  idempotencyKey: string;
  distinctMissionReason: string;
  distinctMissionAuthority: Readonly<{
    confirmedUserAuthorized: true;
    selection: "start_distinct_mission";
    source: "current_request_explicit" | "followup_explicit_choice";
  }>;
}>;

export type ReserveVitractCredentialIssuanceInput = Readonly<{
  lifecycle: PreparedFlowAuthoring;
  credentialName: string;
  publicOperationId?: string;
  expiresAt: string;
}>;

export type PrepareVitractCredentialIssuanceSurfaceInput = Readonly<{
  lifecycle: PreparedFlowAuthoring;
  loginEmailReferenceId: string;
  loginPasswordReferenceId: string;
  applicationResourceScope: string;
  idempotencyKey: string;
}>;

/**
 * Supported composition boundary for the separately-authorized Vitract setup
 * operation. Preparation creates generated lifecycle identities and reservation
 * persists exact observed facts, but neither method can authorize or dispatch.
 */
@Injectable()
export class VitractCredentialIssuancePreparationService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(MissionFlowAuthoringService) private readonly authoring: MissionFlowAuthoringService,
  ) {}

  async createLifecycle(principal: Principal, input: PrepareVitractCredentialIssuanceInput) {
    const canonical = await this.assertCanonicalScopeAndLoginReferences(input);
    const prepared = await this.authoring.prepare(principal, {
      kind: "create",
      projectId: input.projectId,
      environmentId: input.environmentId,
      mission: {
        title: `Vitract credential issuance:${input.idempotencyKey}`,
        originalInstruction: "Prepare exactly one separately-authorized Vitract Preview/Test credential issuance.",
        provider: "operator",
        instructionSnapshot: "Prepare only. Await exact protected-operation authorization before dispatch.",
        distinctReason: input.distinctMissionReason,
        distinctAuthority: input.distinctMissionAuthority,
      },
      objective: {
        title: "Issue one Vitract Preview/Test credential pair",
        description: "Generated-scope setup operation; no Q5 provider attempt.",
        dependencies: [],
        completionCriteria: [
          { description: "one typed credential pair is persisted with exact producer provenance", required: true },
        ],
        order: 0,
      },
      draft: {
        name: "Vitract credential issuance preparation",
        description: "Operator-authorized canonical credential setup",
        purpose: "primary",
        content: {
          objective: "Prepare and issue exactly one Vitract Preview/Test credential pair",
          preconditions: ["canonical generated scope", "exact operator authorization"],
          expectedOutcomes: ["generated-safe client identity", "protected client secret"],
          prohibitedSideEffects: ["second issuance", "Q5 attempt consumption"],
        },
        plan: {
          name: "Vitract credential issuance",
          objective: "Prepare one separately-authorized credential issuance",
          preconditions: ["canonical Q5 scope", "same live Praxis owner"],
          allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
          budgets: { maxActions: 20, maxDurationMs: 900_000, maxNavigations: 8 },
          checkpoints: [],
          steps: [],
        },
      },
      authoring: {
        objective: `Prepare credential issuance for ${input.applicationResourceScope}`,
        allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
        turnBudgets: { maxOperations: 20, maxDurationMs: 900_000 },
        initialProtectedReferenceIds: canonical.environmentAuthorized
          ? [input.loginEmailReferenceId, input.loginPasswordReferenceId]
          : [],
      },
      idempotencyKey: input.idempotencyKey,
    });
    const trustedScriptOrigins = [
      ...new Set([
        ...policyStringArray(canonical.policy, "trustedScriptOrigins"),
        ...VITRACT_TRUSTED_SCRIPT_ORIGINS,
      ]),
    ];
    if (
      !canonical.environmentAuthorized ||
      trustedScriptOrigins.length !== policyStringArray(canonical.policy, "trustedScriptOrigins").length
    ) {
      await new ProjectConfigurationRepository(this.database).updateEnvironment(
        principal,
        input.environmentId,
        {
          missionId: prepared.missionId,
          objectiveId: prepared.objectiveId,
          agentSessionId: prepared.agentSessionId,
          baseOrigin: canonical.baseOrigin,
          policy: { ...(canonical.policy as object), trustedScriptOrigins } as never,
          secretRefs: [input.loginEmailReferenceId, input.loginPasswordReferenceId],
          missionCredentialSelectionRefs: [
            input.loginEmailReferenceId,
            input.loginPasswordReferenceId,
          ],
        },
      );
    }
    await this.authoring.close(
      principal,
      prepared.authoringSessionId,
      `${input.idempotencyKey}-bootstrap-close`,
    );
    const protectedSession = await this.authoring.start(principal, {
      projectId: input.projectId,
      environmentId: input.environmentId,
      missionId: prepared.missionId,
      objectiveId: prepared.objectiveId,
      agentSessionId: prepared.agentSessionId,
      flowDraftId: prepared.flowDraftId,
      objective: `Prepare credential issuance for ${input.applicationResourceScope}`,
      allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
      initialProtectedReferenceIds: [
        input.loginEmailReferenceId,
        input.loginPasswordReferenceId,
      ],
      turnBudgets: { maxOperations: 20, maxDurationMs: 900_000 },
      correlationId: randomUUID(),
      idempotencyKey: `${input.idempotencyKey}-protected-owner`,
      protection: "protected",
    });
    return { ...prepared, authoringSessionId: protectedSession.id, reused: false };
  }

  async reserveObserved(principal: Principal, input: ReserveVitractCredentialIssuanceInput) {
    const observed = await this.authoring.observeOperationContracts(
      principal,
      input.lifecycle.authoringSessionId,
    );
    const matching = observed.contracts.filter(
      (contract) => contract.operation.key === "issuePartnerCredential",
    );
    if (matching.length !== 1)
      throw new ConflictException({ code: "VITRACT_ISSUANCE_CONTRACT_NOT_UNIQUE" });
    const contract = matching[0]!;
    const field = contract.inputs.find((candidate) => candidate.key === "credentialName");
    if (!field?.controlReference)
      throw new ConflictException({ code: "VITRACT_ISSUANCE_NAME_CONTROL_UNAVAILABLE" });
    const publicOperationId = input.publicOperationId ?? `vitract-credential-issuance-${randomUUID()}`;
    const values: ReservePreparedProtectedOperationInput["values"] = [
      {
        canonicalFieldKey: "credentialName",
        targetReference: field.controlReference,
        presentationClass: "plain_text",
        source: { kind: "literal_public", value: input.credentialName },
      },
    ];
    const expectedOutputs = contract.response.safeOutputs.map(({ key, classification }) => ({
      key,
      classification,
    }));
    if (
      stable(expectedOutputs) !==
      stable([
        { key: "credentialRecordId", classification: "public" },
        { key: "clientId", classification: "public" },
        { key: "clientSecret", classification: "protected" },
      ])
    )
      throw new ConflictException({ code: "VITRACT_ISSUANCE_OUTPUT_CONTRACT_MISMATCH" });
    const immutable = {
      projectId: await this.projectIdFor(input.lifecycle),
      environmentId: input.lifecycle.environmentId,
      missionId: input.lifecycle.missionId,
      objectiveId: input.lifecycle.objectiveId,
      agentSessionId: input.lifecycle.agentSessionId,
      praxisSessionId: input.lifecycle.authoringSessionId,
      publicOperationId,
      observedOperationContractId: contract.id,
      observedOperationContractDigest: contract.digest,
      documentEpoch: contract.documentEpoch,
      targetCommitment: digest(
        values.map((value) => ({
          key: value.canonicalFieldKey,
          targetReference: value.targetReference,
        })),
      ),
      inputCommitment: digest(
        values.map((value) => ({
          key: value.canonicalFieldKey,
          presentationClass: value.presentationClass,
          sourceCommitment: digest(value.source),
        })),
      ),
      outputCommitment: digest(
        [...expectedOutputs].sort((left, right) => left.key.localeCompare(right.key)),
      ),
      values,
      expectedOutputs,
      expiresAt: input.expiresAt,
    };
    const reserved = await this.authoring.reservePreparedOperation(
      principal,
      input.lifecycle.authoringSessionId,
      immutable,
    );
    return {
      ...reserved,
      immutableResume: {
        protectedOperationId: reserved.protectedOperationId,
        publicOperationId,
        praxisSessionId: input.lifecycle.authoringSessionId,
        observedOperationContractDigest: contract.digest,
        targetCommitment: immutable.targetCommitment,
        inputCommitment: immutable.inputCommitment,
        outputCommitment: immutable.outputCommitment,
      },
    };
  }

  async prepareObservedSurface(
    principal: Principal,
    input: PrepareVitractCredentialIssuanceSurfaceInput,
  ) {
    const common = {
      objectiveId: input.lifecycle.objectiveId,
      flowDraftId: input.lifecycle.flowDraftId,
      constraints: { timeoutMs: 60_000, allowNewPage: false, allowNonExact: false },
    };
    const credentialUrl = `https://preview.vitract.com/partner/developer/applications/${encodeURIComponent(input.applicationResourceScope)}/credentials`;
    const intents: MissionAuthoringIntent[] = [
      {
        ...common,
        intentId: `${input.idempotencyKey}-open-login`,
        action: { kind: "navigate", url: "https://preview.vitract.com/login" },
        expectedEffect: { kind: "navigation", url: "https://preview.vitract.com/login", match: "exact" },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      },
      {
        ...common,
        intentId: `${input.idempotencyKey}-email`,
        action: {
          kind: "fill",
          target: { concept: "login email", role: "textbox", placeholder: "Enter your email", exact: true },
          protectedReferenceId: input.loginEmailReferenceId,
        },
        expectedEffect: { kind: "none" },
        authorization: { kind: "authentication" },
        protectedInputReferences: [input.loginEmailReferenceId],
      },
      {
        ...common,
        intentId: `${input.idempotencyKey}-password`,
        action: {
          kind: "fill",
          target: { concept: "login password", role: "textbox", placeholder: "Enter your password", exact: true },
          protectedReferenceId: input.loginPasswordReferenceId,
        },
        expectedEffect: { kind: "none" },
        authorization: { kind: "authentication" },
        protectedInputReferences: [input.loginPasswordReferenceId],
      },
      {
        ...common,
        intentId: `${input.idempotencyKey}-login`,
        action: { kind: "activate", semanticEffect: "unknown", target: { concept: "sign in", role: "button", name: "Login", exact: true } },
        expectedEffect: { kind: "navigation", url: "https://preview.vitract.com/partner", match: "exact" },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      },
      {
        ...common,
        intentId: `${input.idempotencyKey}-credentials`,
        action: { kind: "navigate", url: credentialUrl },
        expectedEffect: { kind: "target_visibility", target: { concept: "add credential", role: "button", name: "Add credential", exact: true }, visible: true },
        authorization: { kind: "live_read" },
        protectedInputReferences: [],
      },
      {
        ...common,
        intentId: `${input.idempotencyKey}-open-dialog`,
        action: {
          kind: "activate",
          semanticEffect: "unknown",
          target: { concept: "add credential", role: "button", name: "Add credential", exact: true },
        },
        expectedEffect: {
          kind: "target_visibility",
          target: { concept: "credential name", role: "textbox", name: "Name", exact: true },
          visible: true,
        },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      },
    ];
    const [navigation, ...protectedPreparation] = intents;
    let turn: any = await this.authoring.advance(principal, input.lifecycle.authoringSessionId, {
      kind: "intents",
      intents: [navigation!],
      budgets: { maxOperations: 1, maxDurationMs: 60_000 },
      idempotencyKey: `${input.idempotencyKey}-navigate`,
    });
    for (let poll = 1; turn.state === "pending" && poll <= 80; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      turn = await this.authoring.advance(principal, input.lifecycle.authoringSessionId, {
        kind: "continue",
        turnId: turn.turnId,
        budgets: { maxOperations: 1, maxDurationMs: 60_000 },
        idempotencyKey: `${input.idempotencyKey}-navigate-${poll}`,
      });
    }
    if (turn.state !== "completed")
      throw new ConflictException({ code: "VITRACT_ISSUANCE_SURFACE_PREPARATION_FAILED" });

    let loginObservation: any;
    for (let poll = 0; poll < 240; poll += 1) {
      const observation: any = await this.authoring.observe(
        principal,
        input.lifecycle.authoringSessionId,
      );
      if (
        observation.semanticPageContext?.controls?.some(
          (control: any) =>
            control.role === "textbox" &&
            (control.name === "Enter your email" || control.placeholder === "Enter your email"),
        )
      ) {
        loginObservation = observation;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!loginObservation)
      throw new ConflictException({ code: "VITRACT_LOGIN_SURFACE_NOT_READY" });

    const controls: any[] = loginObservation.semanticPageContext.controls;
    const emailControl = controls.find(
      (control) => control.role === "textbox" && control.name === "Enter your email",
    );
    const passwordControl = controls.find(
      (control) =>
        control.role === "textbox" &&
        control.valueProtected === true &&
        control.semanticPurpose === "password",
    );
    if (!emailControl?.reference || !passwordControl?.reference)
      throw new ConflictException({ code: "VITRACT_LOGIN_EXACT_REFERENCES_UNAVAILABLE" });
    const groundedPreparation = protectedPreparation.map((intent, index) => {
      if (index !== 0 && index !== 1) return intent;
      if (intent.action.kind !== "fill") return intent;
      return {
        ...intent,
        action: {
          ...intent.action,
          target: {
            ...intent.action.target,
            reference: index === 0 ? emailControl.reference : passwordControl.reference,
          },
        },
      } satisfies MissionAuthoringIntent;
    });

    turn = await this.authoring.advance(principal, input.lifecycle.authoringSessionId, {
      kind: "intents",
      intents: groundedPreparation,
      budgets: { maxOperations: groundedPreparation.length, maxDurationMs: 240_000 },
      idempotencyKey: `${input.idempotencyKey}-surface`,
    });
    for (let poll = 1; turn.state === "pending" && poll <= 160; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      turn = await this.authoring.advance(principal, input.lifecycle.authoringSessionId, {
        kind: "continue",
        turnId: turn.turnId,
        budgets: { maxOperations: groundedPreparation.length, maxDurationMs: 240_000 },
        idempotencyKey: `${input.idempotencyKey}-surface-${poll}`,
      });
    }
    if (turn.state !== "completed")
      throw new ConflictException({ code: "VITRACT_ISSUANCE_SURFACE_PREPARATION_FAILED" });
    return turn;
  }

  async executeAuthorized(
    principal: Principal,
    lifecycle: PreparedFlowAuthoring,
    immutableReservation: ResumePreparedProtectedOperationInput,
  ) {
    await this.authoring.resumePreparedOperation(
      principal,
      lifecycle.authoringSessionId,
      immutableReservation,
    );
    return this.authoring.dispatchPreparedOperation(
      principal,
      lifecycle.authoringSessionId,
      immutableReservation,
    );
  }

  async closePrepared(
    principal: Principal,
    lifecycle: PreparedFlowAuthoring,
    idempotencyKey: string,
  ) {
    await this.authoring.abandonPreparedReservations(
      principal,
      lifecycle.authoringSessionId,
    );
    return this.authoring.close(principal, lifecycle.authoringSessionId, idempotencyKey);
  }

  private async projectIdFor(lifecycle: PreparedFlowAuthoring) {
    const result = await this.database.query<{ projectId: string }>(
      `SELECT project_id::text AS "projectId" FROM adaptive_sessions
        WHERE id=$1 AND environment_id=$2 AND mission_id=$3 AND active_objective_id=$4
          AND agent_session_id=$5`,
      [
        lifecycle.authoringSessionId,
        lifecycle.environmentId,
        lifecycle.missionId,
        lifecycle.objectiveId,
        lifecycle.agentSessionId,
      ],
    );
    if (result.rowCount !== 1)
      throw new ConflictException({ code: "VITRACT_ISSUANCE_LIFECYCLE_SCOPE_MISMATCH" });
    return result.rows[0]!.projectId;
  }

  private async assertCanonicalScopeAndLoginReferences(input: PrepareVitractCredentialIssuanceInput) {
    if (input.loginEmailReferenceId === input.loginPasswordReferenceId)
      throw new ConflictException({ code: "VITRACT_LOGIN_PAIR_INVALID" });
    const result = await this.database.query<{
      environmentAuthorized: boolean;
      baseOrigin: string;
      policy: unknown;
    }>(
      `SELECT environment.secret_refs ?& $3::text[] AS "environmentAuthorized",
              environment.base_origin AS "baseOrigin",environment.policy
         FROM q5_canonical_scope_designations designation
        JOIN environments environment ON environment.id=designation.environment_id
        WHERE designation.qualification_key='m6-q5-authoritative'
          AND designation.project_id=$1 AND designation.environment_id=$2
          AND designation.application_identity='vitract-preview-test'
          AND environment.base_origin='https://preview-api.vitract.com'
          AND (SELECT count(*) FROM project_credentials credential
                WHERE credential.project_id=$1 AND credential.id=ANY($3::uuid[])
                  AND credential.security_status='active' AND credential.deleted_at IS NULL)=2`,
      [input.projectId, input.environmentId, [input.loginEmailReferenceId, input.loginPasswordReferenceId]],
    );
    if (result.rowCount !== 1)
      throw new ConflictException({ code: "VITRACT_ISSUANCE_CANONICAL_SCOPE_INVALID" });
    return result.rows[0]!;
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => `${JSON.stringify(key)}:${stable(candidate)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function policyStringArray(policy: unknown, key: string) {
  if (!policy || typeof policy !== "object") return [];
  const candidate = (policy as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((value): value is string => typeof value === "string")
    : [];
}
