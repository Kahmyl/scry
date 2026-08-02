import { Inject, Injectable } from "@nestjs/common";
import { runObservationSchema, type RunObservation } from "@scry/contracts";

import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";
import { ScryRepository } from "./repository.js";

const terminalStates = new Set(["passed", "failed", "cancelled", "timed_out", "infrastructure_error"]);

@Injectable()
export class RunObservationService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ScryRepository) private readonly repository: ScryRepository,
  ) {}

  async observe(principal: Principal, runId: string): Promise<RunObservation> {
    const run = await this.repository.getRun(principal, runId);
    const attempts = (await this.database.query(
      `SELECT id, attempt_number AS "attemptNumber", state, started_at AS "startedAt",
              completed_at AS "completedAt", error
       FROM attempts WHERE run_id = $1 ORDER BY attempt_number`, [runId],
    )).rows;
    const currentAttempt = attempts.at(-1) ?? null;
    const currentAttemptId = currentAttempt?.id as string | undefined;
    let [stepRows, assertionRows, events, artifactRows, timelineRows, intervals, operations, incidents] = emptyObservationQueries();
    if (currentAttemptId) {
      [stepRows, assertionRows, events, artifactRows, timelineRows, intervals, operations, incidents] = await Promise.all([
          this.database.query(
            `SELECT attempt_id AS "attemptId", step_id AS "stepId", ordinal,
                    action_status AS "actionStatus", action_error AS "actionError", readiness,
                    assertions_summary AS "assertionsSummary", evidence,
                    started_at AS "startedAt", completed_at AS "completedAt", duration_ms AS "durationMs"
             FROM step_results WHERE attempt_id = $1 ORDER BY ordinal`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT attempt_id AS "attemptId", step_id AS "stepId", assertion_index AS "assertionIndex",
                    assertion_type AS "assertionType", status, error
             FROM assertion_results WHERE attempt_id = $1 ORDER BY step_id, assertion_index`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT id, attempt_id AS "attemptId", sequence, type, payload, occurred_at AS "occurredAt"
             FROM run_events WHERE attempt_id = $1 ORDER BY sequence`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT id, attempt_id AS "attemptId", step_id AS "stepId", kind, availability,
                    privacy_classification AS "privacyClassification", failure_provenance AS "failureProvenance",
                    reason_code AS "reasonCode", content_type AS "contentType", size_bytes AS "sizeBytes",
                    checksum_sha256 AS "checksumSha256", metadata AS observation, created_at AS "createdAt"
             FROM artifacts WHERE attempt_id = $1 ORDER BY created_at, id`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT id, sequence, entry_type AS type, artifact_id AS "artifactId", operation_id AS "operationId",
                    channel, started_at AS "startedAt", ended_at AS "endedAt", reason_code AS "reasonCode", metadata
             FROM artifact_timeline_entries WHERE attempt_id = $1 ORDER BY sequence`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT id, operation_id AS "operationId", sequence, mode, started_at AS "startedAt", ended_at AS "endedAt",
                    terminal_state AS "terminalState", safe_boundary_kind AS "safeBoundaryKind", failure_code AS "failureCode"
             FROM privacy_intervals WHERE attempt_id = $1 ORDER BY sequence`, [currentAttemptId],
          ),
          this.database.query(
            `SELECT transaction.operation_id AS "operationId",
                    transaction.lifecycle_state AS "lifecycleState",
                    transaction.mutation_kind AS "mutationKind",
                    transaction.program_digest AS "programDigest",
                    transaction.input_schema_digest AS "inputSchemaDigest",
                    transaction.input_digest AS "inputDigest",
                    transaction.bootstrap_status AS "bootstrapStatus",
                    transaction.preparation_status AS "preparationStatus",
                    transaction.protected_extraction_status AS "protectedExtractionStatus",
                    transaction.public_extraction_status AS "publicExtractionStatus",
                    transaction.protected_persistence_status AS "protectedPersistenceStatus",
                    transaction.public_persistence_status AS "publicPersistenceStatus",
                    transaction.capsule_status AS "capsuleStatus",
                    transaction.reconciliation_status AS "reconciliationStatus",
                    transaction.continuation_status AS "continuationStatus",
                    transaction.evidence_status AS "evidenceStatus",
                    transaction.credential_security_status AS "credentialSecurityStatus",
                    transaction.safe_context_id AS "safeContextId",
                    transaction.protected_context_id AS "protectedContextId",
                    transaction.reason_code AS "reasonCode",
                    transaction.failure_phase AS "failurePhase",
                    transaction.retry_class AS "retryClass",
                    mutation.state AS "mutationState",
                    mutation.public_mutation_reference AS "publicMutationReference",
                    transaction.created_at AS "createdAt", transaction.updated_at AS "updatedAt"
             FROM protected_transactions AS transaction
             LEFT JOIN protected_mutation_ledger AS mutation
               ON mutation.run_id = transaction.run_id AND mutation.operation_id = transaction.operation_id
             WHERE transaction.run_id = $1 ORDER BY transaction.created_at`, [runId],
          ),
          this.database.query(
            `SELECT id, credential_id AS "credentialId", operation_id AS "operationId", adapter_id AS "adapterId",
                    state, reason_code AS "reasonCode", safe_diagnostics AS "safeDiagnostics",
                    created_at AS "createdAt", resolved_at AS "resolvedAt"
             FROM credential_incidents WHERE run_id = $1 ORDER BY created_at`, [runId],
          ),
        ]);
    }

    const planSteps = Array.isArray(run.planSnapshot?.steps) ? run.planSnapshot.steps as Array<{ id?: string; title?: string }> : [];
    const assertionsByStep = new Map<string, Array<Record<string, unknown>>>();
    for (const assertion of assertionRows.rows) {
      const list = assertionsByStep.get(String(assertion.stepId)) ?? [];
      list.push({ index: assertion.assertionIndex, type: assertion.assertionType, status: assertion.status, error: assertion.error ?? null });
      assertionsByStep.set(String(assertion.stepId), list);
    }
    const steps = stepRows.rows.map((step) => ({
      attemptId: step.attemptId,
      stepId: step.stepId,
      title: planSteps.find((candidate) => candidate.id === step.stepId)?.title ?? String(step.stepId),
      ordinal: step.ordinal,
      action: { status: step.actionStatus, error: step.actionError ?? null },
      readiness: step.readiness ?? null,
      assertions: assertionsByStep.get(String(step.stepId)) ?? [],
      assertionsSummary: step.assertionsSummary ?? { passed: 0, failed: 0, unevaluated: 0 },
      evidence: Array.isArray(step.evidence) ? step.evidence : [],
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      durationMs: step.durationMs ?? null,
    }));
    const artifacts: Array<Record<string, any>> = artifactRows.rows.map((artifact) => ({
      ...artifact,
      stepId: artifact.stepId ?? null,
      failureProvenance: artifact.failureProvenance ?? null,
      reasonCode: artifact.reasonCode ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
      checksumSha256: artifact.checksumSha256 ?? null,
      observation: artifact.observation ?? {},
      resource: artifact.availability === "available" ? `scry://artifact/${artifact.id}` : null,
    }));
    const artifactTimeline = timelineRows.rows.map(({ metadata, id, sequence, type }) => ({
      ...(metadata as Record<string, unknown>), id, sequence, type,
    }));
    const failure = deriveFailure(run, currentAttempt, steps, events.rows);
    const integrity = inspectIntegrity(run, currentAttempt, planSteps, steps, artifacts, artifactTimeline);
    const active = !terminalStates.has(String(run.state));
    const section = (items: unknown[]) => items.length ? "complete" as const : active ? "pending" as const : "complete" as const;
    const safeActions: RunObservation["safeActions"] = [];
    if (active) safeActions.push("cancel");
    else safeActions.push("rerun");
    if (failure && ["plan", "product"].includes(failure.provenance)) safeActions.push("revise_flow");
    if (artifacts.some((artifact) => artifact.availability === "available")) safeActions.push("read_artifact");

    return runObservationSchema.parse({
      run,
      attempts,
      currentAttempt,
      steps,
      events: events.rows,
      artifacts,
      artifactTimeline: artifactTimeline as RunObservation["artifactTimeline"],
      privacy: { intervals: intervals.rows, operations: operations.rows, credentialIncidents: incidents.rows },
      failure,
      sections: {
        attempts: section(attempts), steps: section(steps), events: section(events.rows),
        artifacts: section(artifacts), timeline: section(artifactTimeline),
      },
      integrity,
      safeActions,
      release: {
        releaseId: process.env.SCRY_RELEASE_ID ?? "development",
        schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
      },
    });
  }
}

function emptyObservationQueries() {
  return Array.from({ length: 8 }, () => ({ rows: [] as Array<Record<string, any>> })) as [
    { rows: Array<Record<string, any>> }, { rows: Array<Record<string, any>> },
    { rows: Array<Record<string, any>> }, { rows: Array<Record<string, any>> },
    { rows: Array<Record<string, any>> }, { rows: Array<Record<string, any>> },
    { rows: Array<Record<string, any>> }, { rows: Array<Record<string, any>> },
  ];
}

function deriveFailure(run: Record<string, any>, attempt: Record<string, any> | null, steps: Array<Record<string, any>>, events: Array<Record<string, any>>): RunObservation["failure"] {
  if (!attempt && !terminalStates.has(String(run.state))) return null;
  const failedStep = steps.find((step) => step.action.status === "failed" || step.readiness?.status === "failed" || step.assertions.some((assertion: Record<string, any>) => assertion.status === "failed"));
  const failedAssertion = failedStep?.assertions.find((assertion: Record<string, any>) => assertion.status === "failed");
  const policy = [...events].reverse().find((event) => event.type === "policy.rejected" && event.payload?.disposition !== "blocked_subresource");
  const classification = String(run.outcomeClassification ?? "");
  if (!failedStep && !attempt?.error && !policy && run.state === "passed") return null;
  const provenance = classification === "infrastructure_failure" || run.state === "infrastructure_error" ? "infrastructure"
    : classification === "policy_failure" || policy ? "policy"
    : classification.includes("assertion") || classification === "confirmed_product_failure" ? "product"
    : classification === "cancelled" || classification === "execution_timeout" ? "executor"
    : "plan";
  const readinessError = failedStep?.readiness && typeof failedStep.readiness === "object" ? failedStep.readiness.error : undefined;
  const message = failedStep?.action.error ?? readinessError ?? failedAssertion?.error ?? attempt?.error ?? policy?.payload?.message;
  return {
    provenance,
    code: String(policy?.payload?.code ?? (classification || `${String(run.state).toUpperCase()}_FAILURE`)),
    ...(message ? { message: String(message) } : {}),
    ...(failedStep ? { stepId: String(failedStep.stepId) } : {}),
    ...(failedStep?.action.status === "failed" ? { channel: "action" } : failedStep?.readiness?.status === "failed" ? { channel: "readiness" } : failedAssertion ? { channel: "assertion" } : {}),
  };
}

function inspectIntegrity(run: Record<string, any>, attempt: Record<string, any> | null, planSteps: Array<Record<string, any>>, steps: Array<Record<string, any>>, artifacts: Array<Record<string, any>>, timeline: Array<Record<string, any>>): RunObservation["integrity"] {
  const issues: Array<{ code: string; message: string }> = [];
  const terminal = terminalStates.has(String(run.state));
  if (terminal && !attempt) issues.push({ code: "TERMINAL_ATTEMPT_MISSING", message: "The terminal run has no persisted attempt." });
  if (terminal && attempt && !attempt.completedAt) issues.push({ code: "TERMINAL_ATTEMPT_INCOMPLETE", message: "The terminal attempt has no completion timestamp." });
  if (terminal && planSteps.length > 0 && steps.length === 0 && run.state !== "infrastructure_error") issues.push({ code: "TERMINAL_STEP_RESULTS_MISSING", message: "The terminal run has no persisted step results." });
  const artifactIds = new Set(artifacts.map((artifact) => String(artifact.id)));
  for (const entry of timeline) if (entry.artifactId && !artifactIds.has(String(entry.artifactId))) issues.push({ code: "TIMELINE_ARTIFACT_MISSING", message: `Timeline entry ${String(entry.id)} references an unavailable artifact manifest record.` });
  const timelineArtifactIds = new Set(timeline.map((entry) => entry.artifactId).filter(Boolean).map(String));
  for (const artifact of artifacts) if (artifact.availability === "available" && ["video", "trace"].includes(String(artifact.kind)) && !timelineArtifactIds.has(String(artifact.id))) issues.push({ code: "AVAILABLE_ARTIFACT_TIMELINE_MISSING", message: `Available ${String(artifact.kind)} artifact ${String(artifact.id)} is absent from the artifact timeline.` });
  return { status: issues.length ? "failed" : terminal ? "complete" : "partial", issues };
}
