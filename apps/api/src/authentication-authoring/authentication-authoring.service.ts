import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  type AuthTargetEvidence,
  type AuthFieldResolution,
  type AuthStateResult,
  type AuthSubmissionResolution,
  type AuthSubmissionResult,
  type AuthenticationContractCandidate,
  type AuthenticationTranscript,
  authenticationContractCandidateSchema,
} from "@scry/contracts";

import { AuthenticationAttemptRepository } from "./repositories/authentication-attempt.repository.js";

type AuthField = "username" | "password";
type PraxisCandidate = {
  target: AuthFieldResolution["target"];
  confidence: number;
  runnerUpMargin?: number;
  evidenceKinds?: string[];
  evidenceText?: string[];
};
type SubmissionCandidate = {
  kind: "native_submit" | "form_button" | "enter_password" | "custom_control" | "application_adapter";
  target?: AuthFieldResolution["target"];
  confidence: number;
  evidenceKinds?: string[];
};
type AuthContext = {
  probeSessionId: string;
  applicationOrigin: string;
  entryUrl: string;
  credentialReferenceId?: string;
  usernameInspection?: { candidates: PraxisCandidate[] };
  passwordInspection?: { candidates: PraxisCandidate[] };
  submissionInspection?: { candidates: SubmissionCandidate[] };
  stateInspection?: { signals: AuthStateResult["signals"] };
};

export interface AuthenticationAuthoringKernel {
  discoverUsernameField(context: AuthContext): Promise<AuthFieldResolution>;
  discoverPasswordField(context: AuthContext): Promise<AuthFieldResolution>;
  discoverSubmissionPath(context: AuthContext): Promise<AuthSubmissionResolution>;
  submitCredentialsOnce(context: AuthContext): Promise<AuthSubmissionResult>;
  detectAuthenticatedState(context: AuthContext): Promise<AuthStateResult>;
  createAuthenticationContractCandidate(
    transcript: AuthenticationTranscript,
  ): Promise<AuthenticationContractCandidate>;
}

@Injectable()
export class AuthenticationAuthoringService implements AuthenticationAuthoringKernel {
  constructor(
    _praxis: unknown,
    @Inject(AuthenticationAttemptRepository)
    private readonly attempts: AuthenticationAttemptRepository,
  ) {}

  async discoverUsernameField(context: AuthContext): Promise<AuthFieldResolution> {
    return this.resolveField("username", context.usernameInspection?.candidates ?? [], [
      "autocomplete_username",
      "autocomplete_email",
      "type_email",
      "semantic_name",
      "label",
      "form_relationship",
      "previous_successful_history",
      "praxis_verified",
    ]);
  }

  async discoverPasswordField(context: AuthContext): Promise<AuthFieldResolution> {
    return this.resolveField("password", context.passwordInspection?.candidates ?? [], [
      "type_password",
      "autocomplete_current_password",
      "form_relationship",
      "label",
      "previous_successful_history",
      "praxis_verified",
    ]);
  }

  async discoverSubmissionPath(context: AuthContext): Promise<AuthSubmissionResolution> {
    const order = [
      "native_submit",
      "form_button",
      "enter_password",
      "custom_control",
      "application_adapter",
    ] as const;
    const methods = (context.submissionInspection?.candidates ?? [])
      .filter((candidate) => candidate.confidence >= 0.72)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      .map((candidate, index) => ({
        kind:
          candidate.kind === "enter_password"
            ? ("press_enter" as const)
            : candidate.kind === "application_adapter"
              ? ("request" as const)
              : ("click" as const),
        order: index + 1,
        ...(candidate.target ? { target: sanitizeTarget(candidate.target) } : {}),
        verification: {
          status: "verified" as const,
          evidence: evidence(candidate.evidenceKinds ?? ["praxis_verified"], "submission path"),
        },
      }));

    if (!methods.length) {
      return {
        status: "blocked",
        methods: [
          {
            kind: "press_enter",
            order: 1,
            verification: {
              status: "blocked",
              evidence: evidence(["praxis_verified"], "no verified submission path"),
            },
          },
        ],
        qualityFindings: ["No verified credential submission method was available."],
      };
    }

    return {
      status: "resolved",
      selectedMethodIndex: 0,
      methods,
      qualityFindings: [],
    };
  }

  async submitCredentialsOnce(context: AuthContext): Promise<AuthSubmissionResult> {
    return this.authorizeCredentialSubmission(context);
  }

  async authorizeCredentialSubmission(context: AuthContext): Promise<AuthSubmissionResult> {
    const submission = await this.discoverSubmissionPath(context);
    const method = submission.methods[submission.selectedMethodIndex ?? 0]!;
    const attemptInput = {
      probeSessionId: context.probeSessionId,
      submissionMethod: method.kind,
      safeMetadata: { applicationOrigin: context.applicationOrigin },
      ...(context.credentialReferenceId
        ? { credentialReferenceId: context.credentialReferenceId }
        : {}),
    };
    const attemptId = await this.attempts.create(attemptInput);

    const claimed = await this.attempts.beginDispatch(attemptId);
    if (!claimed) {
      await this.attempts.finish({
        attemptId,
        dispatchState: "blocked",
        mutationBoundaryObserved: false,
        resultClassification: "already_dispatched",
      });
      return {
        status: "already_dispatched" as const,
        attemptId,
        submissionMethod: method,
        mutationBoundaryObserved: false,
        safeMetadata: {},
      };
    }

    if (submission.status !== "resolved" || method.verification.status !== "verified") {
      await this.attempts.finish({
        attemptId,
        dispatchState: "blocked",
        mutationBoundaryObserved: false,
        resultClassification: "blocked",
      });
      return {
        status: "blocked" as const,
        attemptId,
        submissionMethod: method,
        mutationBoundaryObserved: false,
        safeMetadata: {},
      };
    }

    const mutationBoundaryObserved = Boolean(context.stateInspection?.signals?.length);
    const status: AuthSubmissionResult["status"] = mutationBoundaryObserved
      ? "submitted"
      : "uncertain_dispatch";
    await this.attempts.finish({
      attemptId,
      dispatchState: mutationBoundaryObserved ? "dispatched" : "uncertain",
      mutationBoundaryObserved,
      resultClassification: status,
    });

    return {
      status,
      attemptId,
      submissionMethod: method,
      mutationBoundaryObserved,
      safeMetadata: {},
    };
  }

  async detectAuthenticatedState(context: AuthContext): Promise<AuthStateResult> {
    const signals = [...new Set(context.stateInspection?.signals ?? [])];
    const requiredSignals: AuthStateResult["requiredSignals"] = signals.filter((signal) =>
      (["login_response_success", "url_not_login", "login_form_absent"] as const).includes(
        signal as never,
      ),
    );
    const optionalSignals = signals.filter((signal) => !requiredSignals.includes(signal));
    const confidence = Math.min(1, requiredSignals.length * 0.34 + optionalSignals.length * 0.16);
    return {
      status: (requiredSignals.length >= 2 && signals.length >= 3
        ? "authenticated"
        : signals.length >= 2
          ? "uncertain"
          : "unauthenticated") as AuthStateResult["status"],
      signals,
      confidence,
      requiredSignals: requiredSignals.length ? requiredSignals : ["login_form_absent"],
      optionalSignals,
      qualityFindings:
        signals.length >= 3 ? [] : ["Authenticated state requires multiple independent signals."],
    };
  }

  async createAuthenticationContractCandidate(transcript: AuthenticationTranscript) {
    if (
      transcript.username.status !== "resolved" ||
      transcript.password.status !== "resolved" ||
      !transcript.username.target ||
      !transcript.password.target
    ) {
      throw new BadRequestException("AUTHENTICATION_FIELDS_NOT_RESOLVED");
    }
    if (transcript.submission.status !== "resolved") {
      throw new BadRequestException("AUTHENTICATION_SUBMISSION_NOT_RESOLVED");
    }
    if (transcript.authenticatedState.status !== "authenticated") {
      throw new BadRequestException("AUTHENTICATED_STATE_NOT_PROVEN");
    }

    const candidate = {
      applicationOrigin: transcript.applicationOrigin,
      entryUrl: transcript.entryUrl,
      usernameTarget: sanitizeTarget(transcript.username.target),
      passwordTarget: sanitizeTarget(transcript.password.target),
      submissionMethods: transcript.submission.methods.map((method) => ({
        kind: method.kind,
        ...(method.target ? { target: sanitizeTarget(method.target) } : {}),
      })),
      selectedMethodIndex: transcript.submission.selectedMethodIndex ?? 0,
      success: {
        requiredSignals: transcript.authenticatedState.requiredSignals,
        optionalSignals: transcript.authenticatedState.optionalSignals,
        minimumRequiredSignals: Math.min(2, transcript.authenticatedState.requiredSignals.length),
        stabilityWindowMs: 500,
        timeoutMs: 15_000,
      },
      failureSignals: transcript.authenticatedState.qualityFindings,
      sessionReuse: "never" as const,
      qualityFindings: [
        ...transcript.username.qualityFindings,
        ...transcript.password.qualityFindings,
        ...transcript.submission.qualityFindings,
        ...transcript.authenticatedState.qualityFindings,
      ],
    };

    rejectUnsafe(candidate);
    return authenticationContractCandidateSchema.parse(candidate);
  }

  private resolveField(
    field: AuthField,
    candidates: PraxisCandidate[],
    priority: string[],
  ): AuthFieldResolution {
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score:
          candidate.confidence +
          (candidate.runnerUpMargin ?? 0) +
          bestEvidencePriority(candidate.evidenceKinds ?? [], priority),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];

    if (!best) {
      return {
        status: "blocked",
        field,
        confidence: 0,
        evidence: evidence(["praxis_verified"], `no ${field} field resolved`),
        candidatesConsidered: 0,
        qualityFindings: [`No ${field} field candidate was verified by Praxis.`],
      };
    }

    if (second && best.score - second.score < 0.18) {
      return {
        status: "ambiguous",
        field,
        confidence: best.candidate.confidence,
        evidence: evidence(best.candidate.evidenceKinds ?? ["praxis_verified"], `${field} ambiguous`),
        candidatesConsidered: candidates.length,
        qualityFindings: [`Multiple plausible ${field} fields require author assistance.`],
      };
    }

    return {
      status: "resolved",
      field,
      target: sanitizeTarget(best.candidate.target),
      confidence: best.candidate.confidence,
      evidence: evidence(best.candidate.evidenceKinds ?? ["praxis_verified"], `${field} resolved`),
      candidatesConsidered: candidates.length,
      qualityFindings: [],
    };
  }
}

function bestEvidencePriority(kinds: string[], priority: string[]) {
  const indexes = kinds
    .map((kind) => priority.indexOf(kind))
    .filter((index) => index >= 0);
  if (!indexes.length) return 0;
  return (priority.length - Math.min(...indexes)) / 10;
}

function evidence(kinds: string[], summary: string): AuthTargetEvidence[] {
  return kinds.slice(0, 8).map((kind) => ({
    kind: normalizeEvidenceKind(kind),
    confidence: 0.9,
    source: "praxis" as const,
    summary,
  }));
}

function normalizeEvidenceKind(kind: string): AuthTargetEvidence["kind"] {
  const allowed = new Set([
    "autocomplete_username",
    "autocomplete_email",
    "type_email",
    "semantic_name",
    "label",
    "form_relationship",
    "previous_successful_history",
    "type_password",
    "autocomplete_current_password",
    "praxis_verified",
  ]);
  return (allowed.has(kind) ? kind : "praxis_verified") as AuthTargetEvidence["kind"];
}

function sanitizeTarget(target: AuthFieldResolution["target"]) {
  if (!target || target.authority !== "praxis") {
    throw new BadRequestException("AUTHENTICATION_TARGET_REQUIRES_PRAXIS_AUTHORITY");
  }
  return {
    authority: "praxis" as const,
    fingerprint: target.fingerprint,
    concept: target.concept,
    scopeKind: target.scopeKind,
    capabilityDigest: target.capabilityDigest,
    ...(target.runtimeIdentity ? { runtimeIdentity: target.runtimeIdentity } : {}),
  };
}

function rejectUnsafe(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (const unsafe of ["password=", "token=", "clipboard", "selector", "css=", "xpath", "screenshot", "<html"]) {
    if (text.includes(unsafe)) {
      throw new BadRequestException("AUTHENTICATION_CANDIDATE_CONTAINS_UNSAFE_ARTIFACT");
    }
  }
}
