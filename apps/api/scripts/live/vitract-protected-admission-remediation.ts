import {
  executionPolicySchema,
  missionAuthoringIntentSchema,
  type MissionAuthoringIntent,
} from "@scry/contracts";

import { ProjectConfigurationRepository } from "../../src/access/repositories/project-configuration.repository.js";
import { AdaptiveSessionRepository } from "../../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../../src/infrastructure/database.js";

const SESSION_ID = process.env.SCRY_LIVE_SESSION_ID ?? "0197cbc4-9560-43f7-8c47-3f69a11de8d2";

const ENVIRONMENT_ID =
  process.env.SCRY_LIVE_ENVIRONMENT_ID ?? "faca3dad-9ff7-4633-b058-1239d0aefb65";

const EMAIL_REFERENCE =
  process.env.SCRY_LIVE_EMAIL_REFERENCE ?? "950c756d-c595-4f09-9f05-d64ceeab5cf9";

const PASSWORD_REFERENCE =
  process.env.SCRY_LIVE_PASSWORD_REFERENCE ?? "ecc3f126-9a68-4994-9869-dc63a987786c";

const SELECTED_REFERENCES = [EMAIL_REFERENCE, PASSWORD_REFERENCE].sort();

type AdmissionFact = {
  credential: "email" | "password";
  admitted: boolean;
  code: string;
};

const output = {
  failureStage: "BOOTSTRAP",
  failureCode: "none",

  beforeAllowlist: [] as string[],
  afterAllowlist: [] as string[],

  beforeAdmission: [] as AdmissionFact[],
  afterAdmission: [] as AdmissionFact[],

  environmentSecretRefCount: 0,
  admittedPraxisSessionCount: 0,

  selectedOnly: false,
  oldEnvironmentCredentialsNotAdmitted: false,
  authorizationBoundaryCleared: false,

  result: "LIVE_PROTECTED_ADMISSION_REMEDIATION_FAIL" as
    "LIVE_PROTECTED_ADMISSION_REMEDIATION_PASS" | "LIVE_PROTECTED_ADMISSION_REMEDIATION_FAIL",
};

const database = new Database();
const adaptive = new AdaptiveSessionRepository(database);
const configuration = new ProjectConfigurationRepository(database);

try {
  output.failureStage = "LOAD_FIXTURE";

  const fixture = await database.query<{
    projectId: string;
    missionId: string;
    objectiveId: string;
    flowDraftId: string;
    agentSessionId: string;
    environmentId: string;
    baseOrigin: string;
    policy: unknown;
    secretRefs: string[];
    protectedAllowlist: string[];
    decisionBoundary: {
      reasonCode?: string;
    } | null;
  }>(
    `SELECT
       session.project_id AS "projectId",
       session.mission_id AS "missionId",
       session.active_objective_id AS "objectiveId",
       session.active_flow_draft_id AS "flowDraftId",
       session.agent_session_id AS "agentSessionId",
       session.environment_id AS "environmentId",
       environment.base_origin AS "baseOrigin",
       environment.policy,
       environment.secret_refs AS "secretRefs",
       session.protected_reference_allowlist AS "protectedAllowlist",
       session.decision_boundary AS "decisionBoundary"
     FROM adaptive_sessions session
     JOIN environments environment
       ON environment.id=session.environment_id
      AND environment.project_id=session.project_id
     WHERE session.id=$1`,
    [SESSION_ID],
  );

  if (fixture.rowCount !== 1) throw coded("LAYER_B_SESSION_UNAVAILABLE");

  const row = fixture.rows[0]!;

  if (row.environmentId !== ENVIRONMENT_ID) throw coded("LAYER_B_ENVIRONMENT_MISMATCH");

  output.beforeAllowlist = [...row.protectedAllowlist].sort();

  output.environmentSecretRefCount = row.secretRefs.length;

  for (const reference of SELECTED_REFERENCES) {
    if (!row.secretRefs.includes(reference))
      throw coded("LAYER_B_SELECTED_REFERENCE_NOT_ENVIRONMENT_AUTHORIZED");
  }

  if (output.beforeAllowlist.length !== 0)
    throw coded("LAYER_B_FIXTURE_ALREADY_HAS_PROTECTED_ADMISSION");

  const intents = {
    email: protectedFillIntent({
      intentId: "layer-b-remediation-email",
      objectiveId: row.objectiveId,
      flowDraftId: row.flowDraftId,
      targetReference: "context-control-11111111111111111111111111111111",
      concept: "login email",
      credentialReference: EMAIL_REFERENCE,
    }),

    password: protectedFillIntent({
      intentId: "layer-b-remediation-password",
      objectiveId: row.objectiveId,
      flowDraftId: row.flowDraftId,
      targetReference: "context-control-22222222222222222222222222222222",
      concept: "login password",
      credentialReference: PASSWORD_REFERENCE,
    }),
  };

  output.failureStage = "PROVE_PRE_FIX_REJECTION";

  output.beforeAdmission.push(await admissionFact(adaptive, "email", intents.email));

  output.beforeAdmission.push(await admissionFact(adaptive, "password", intents.password));

  if (
    !output.beforeAdmission.every(
      (fact) => !fact.admitted && fact.code === "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
    )
  )
    throw coded("LAYER_B_PRE_FIX_REJECTION_NOT_PROVEN");

  output.failureStage = "AUTHORIZE_SELECTED_CREDENTIALS";

  const policy = executionPolicySchema.parse(row.policy);

  const updated = (await configuration.updateEnvironment(
    {
      kind: "service",
      subject: "scry-service",
    } as never,
    ENVIRONMENT_ID,
    {
      missionId: row.missionId,
      objectiveId: row.objectiveId,
      agentSessionId: row.agentSessionId,

      baseOrigin: row.baseOrigin,
      policy,
      secretRefs: row.secretRefs,

      missionCredentialSelectionRefs: SELECTED_REFERENCES,
    },
  )) as {
    admittedPraxisSessionCount?: number;
  };

  output.admittedPraxisSessionCount = updated.admittedPraxisSessionCount ?? 0;

  if (output.admittedPraxisSessionCount < 1)
    throw coded("LAYER_B_NO_MATCHING_PRAXIS_SESSION_ADMITTED");

  output.failureStage = "VERIFY_SESSION_PROJECTION";

  const after = await database.query<{
    protectedAllowlist: string[];
    decisionBoundary: {
      reasonCode?: string;
    } | null;
  }>(
    `SELECT
       protected_reference_allowlist AS "protectedAllowlist",
       decision_boundary AS "decisionBoundary"
     FROM adaptive_sessions
     WHERE id=$1`,
    [SESSION_ID],
  );

  if (after.rowCount !== 1) throw coded("LAYER_B_SESSION_LOST_AFTER_AUTHORIZATION");

  output.afterAllowlist = [...after.rows[0]!.protectedAllowlist].sort();

  output.selectedOnly =
    JSON.stringify(output.afterAllowlist) === JSON.stringify(SELECTED_REFERENCES);

  if (!output.selectedOnly) throw coded("LAYER_B_SESSION_ADMISSION_SCOPE_INCORRECT");

  const nonSelectedEnvironmentRefs = row.secretRefs.filter(
    (reference) => !SELECTED_REFERENCES.includes(reference),
  );

  output.oldEnvironmentCredentialsNotAdmitted = nonSelectedEnvironmentRefs.every(
    (reference) => !output.afterAllowlist.includes(reference),
  );

  if (!output.oldEnvironmentCredentialsNotAdmitted)
    throw coded("LAYER_B_UNSELECTED_ENVIRONMENT_REFERENCE_ADMITTED");

  output.authorizationBoundaryCleared =
    row.decisionBoundary?.reasonCode === "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED"
      ? after.rows[0]!.decisionBoundary === null
      : true;

  if (!output.authorizationBoundaryCleared)
    throw coded("LAYER_B_STALE_AUTHORIZATION_BOUNDARY_REMAINED");

  output.failureStage = "VERIFY_POST_FIX_ADMISSION";

  output.afterAdmission.push(await admissionFact(adaptive, "email", intents.email));

  output.afterAdmission.push(await admissionFact(adaptive, "password", intents.password));

  if (!output.afterAdmission.every((fact) => fact.admitted))
    throw coded("LAYER_B_POST_FIX_ADMISSION_FAILED");

  output.failureStage = "none";
  output.failureCode = "none";
  output.result = "LIVE_PROTECTED_ADMISSION_REMEDIATION_PASS";
} catch (error) {
  output.failureCode = safeCode(error);
} finally {
  await database.onModuleDestroy();

  process.stdout.write(
    [
      "============================================================",
      "R0.7 LAYER B — REMEDIATION RESULT",
      "============================================================",
      `failureStage: ${output.failureStage}`,
      `failureCode: ${output.failureCode}`,
      `beforeAllowlist: ${JSON.stringify(output.beforeAllowlist)}`,
      `environmentSecretRefCount: ${output.environmentSecretRefCount}`,
      `beforeAdmission: ${JSON.stringify(output.beforeAdmission)}`,
      `admittedPraxisSessionCount: ${output.admittedPraxisSessionCount}`,
      `afterAllowlist: ${JSON.stringify(output.afterAllowlist)}`,
      `selectedOnly: ${output.selectedOnly}`,
      `oldEnvironmentCredentialsNotAdmitted: ${output.oldEnvironmentCredentialsNotAdmitted}`,
      `authorizationBoundaryCleared: ${output.authorizationBoundaryCleared}`,
      `afterAdmission: ${JSON.stringify(output.afterAdmission)}`,
      `result: ${output.result}`,
      "",
    ].join("\n"),
  );

  process.exitCode = output.result === "LIVE_PROTECTED_ADMISSION_REMEDIATION_PASS" ? 0 : 1;
}

function protectedFillIntent(input: {
  intentId: string;
  objectiveId: string;
  flowDraftId: string;
  targetReference: string;
  concept: string;
  credentialReference: string;
}): MissionAuthoringIntent {
  return missionAuthoringIntentSchema.parse({
    intentId: input.intentId,
    objectiveId: input.objectiveId,
    flowDraftId: input.flowDraftId,

    action: {
      kind: "fill",

      target: {
        concept: input.concept,
        reference: input.targetReference,
        role: "textbox",
        exact: true,
      },

      protectedReferenceId: input.credentialReference,
    },

    expectedEffect: {
      kind: "none",
    },

    constraints: {
      timeoutMs: 20_000,
      allowNewPage: false,
      allowNonExact: false,
    },

    authorization: {
      kind: "authentication",
    },

    protectedInputReferences: [input.credentialReference],
  });
}

async function admissionFact(
  repository: AdaptiveSessionRepository,
  credential: "email" | "password",
  intent: MissionAuthoringIntent,
): Promise<AdmissionFact> {
  try {
    await repository.validateIntentAdmission({
      sessionId: SESSION_ID,
      intent,
    });

    return {
      credential,
      admitted: true,
      code: "none",
    };
  } catch (error) {
    return {
      credential,
      admitted: false,
      code: nestCode(error),
    };
  }
}

function nestCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "getResponse" in error &&
    typeof (
      error as {
        getResponse?: unknown;
      }
    ).getResponse === "function"
  ) {
    const response = (
      error as {
        getResponse(): unknown;
      }
    ).getResponse();

    if (
      typeof response === "object" &&
      response !== null &&
      "code" in response &&
      typeof (
        response as {
          code?: unknown;
        }
      ).code === "string"
    )
      return (
        response as {
          code: string;
        }
      ).code;
  }

  return safeCode(error);
}

function coded(code: string) {
  return Object.assign(new Error(code), { code });
}

function safeCode(error: unknown) {
  const candidate =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (
      error as {
        code?: unknown;
      }
    ).code === "string"
      ? (
          error as {
            code: string;
          }
        ).code
      : error instanceof Error
        ? error.message
        : String(error);

  return /^[A-Z][A-Z0-9_]*$/.test(candidate)
    ? candidate
    : "LAYER_B_REMEDIATION_UNCLASSIFIED_FAILURE";
}
