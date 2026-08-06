import { z } from "zod";

import { authenticatedStateContractSchema } from "./authoring.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const safeText = z.string().trim().min(1).max(1_000);

export const authEvidenceKindSchema = z.enum([
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

export const authDurableTargetSchema = z
  .object({
    authority: z.literal("praxis"),
    fingerprint: digest,
    concept: safeText,
    scopeKind: safeIdentifier,
    capabilityDigest: digest,
    runtimeIdentity: digest.optional(),
  })
  .strict();

export const authTargetEvidenceSchema = z
  .object({
    kind: authEvidenceKindSchema,
    confidence: z.number().min(0).max(1),
    source: z.enum(["praxis", "veil", "history", "authoring_kernel"]),
    summary: safeText,
  })
  .strict();

export const authFieldResolutionSchema = z
  .object({
    status: z.enum(["resolved", "ambiguous", "blocked"]),
    field: z.enum(["username", "password"]),
    target: authDurableTargetSchema.optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(authTargetEvidenceSchema).min(1).max(12),
    candidatesConsidered: z.number().int().nonnegative(),
    qualityFindings: z.array(safeText).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "resolved" && !value.target) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Resolved authentication fields require a Praxis target.",
      });
    }
  });

export const authSubmissionMethodSchema = z
  .object({
    kind: z.enum(["click", "press_enter", "request"]),
    order: z.number().int().positive(),
    target: authDurableTargetSchema.optional(),
    verification: z
      .object({
        status: z.enum(["verified", "blocked", "uncertain"]),
        evidence: z.array(authTargetEvidenceSchema).min(1).max(12),
      })
      .strict(),
  })
  .strict();

export const authSubmissionResolutionSchema = z
  .object({
    status: z.enum(["resolved", "blocked"]),
    selectedMethodIndex: z.number().int().nonnegative().optional(),
    methods: z.array(authSubmissionMethodSchema).min(1).max(5),
    qualityFindings: z.array(safeText).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "resolved" && value.selectedMethodIndex === undefined) {
      context.addIssue({
        code: "custom",
        path: ["selectedMethodIndex"],
        message: "Resolved submissions require a selected method.",
      });
    }
  });

export const authSubmissionResultSchema = z
  .object({
    status: z.enum(["submitted", "blocked", "uncertain_dispatch", "already_dispatched"]),
    attemptId: uuid,
    submissionMethod: authSubmissionMethodSchema,
    mutationBoundaryObserved: z.boolean(),
    safeMetadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const authStateSignalSchema = z.enum([
  "login_response_success",
  "url_not_login",
  "login_form_absent",
  "authenticated_navigation_present",
  "portal_shell_present",
  "session_state_present",
]);

export const authStateResultSchema = z
  .object({
    status: z.enum(["authenticated", "unauthenticated", "uncertain"]),
    signals: z.array(authStateSignalSchema).max(6),
    confidence: z.number().min(0).max(1),
    requiredSignals: z.array(authStateSignalSchema).min(1).max(6),
    optionalSignals: z.array(authStateSignalSchema).max(6).default([]),
    qualityFindings: z.array(safeText).default([]),
  })
  .strict();

export const authenticationTranscriptSchema = z
  .object({
    probeSessionId: uuid,
    applicationOrigin: z.string().url(),
    entryUrl: z.string().url(),
    username: authFieldResolutionSchema,
    password: authFieldResolutionSchema,
    submission: authSubmissionResolutionSchema,
    submissionResult: authSubmissionResultSchema.optional(),
    authenticatedState: authStateResultSchema,
    safeMetadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const authenticationContractCandidateSchema = z
  .object({
    applicationOrigin: z.string().url(),
    entryUrl: z.string().url(),
    usernameTarget: authDurableTargetSchema,
    passwordTarget: authDurableTargetSchema,
    submissionMethods: z
      .array(
        z
          .object({
            kind: z.enum(["click", "press_enter", "request"]),
            target: authDurableTargetSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    selectedMethodIndex: z.number().int().nonnegative(),
    success: authenticatedStateContractSchema,
    failureSignals: z.array(safeText).default([]),
    sessionReuse: z.enum(["never", "project_policy_opt_in"]).default("never"),
    qualityFindings: z.array(safeText).default([]),
  })
  .strict();

export type AuthFieldResolution = z.infer<typeof authFieldResolutionSchema>;
export type AuthTargetEvidence = z.infer<typeof authTargetEvidenceSchema>;
export type AuthSubmissionResolution = z.infer<typeof authSubmissionResolutionSchema>;
export type AuthSubmissionResult = z.infer<typeof authSubmissionResultSchema>;
export type AuthStateResult = z.infer<typeof authStateResultSchema>;
export type AuthenticationTranscript = z.infer<typeof authenticationTranscriptSchema>;
export type AuthenticationContractCandidate = z.infer<
  typeof authenticationContractCandidateSchema
>;
