import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  Image,
  LoaderCircle,
  ShieldCheck,
  Square,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, post, type Report, type Run, type RunState } from "./api.js";
import { formatDuration } from "./dashboard-format.js";
import {
  EmptyBlock,
  PageSkeleton,
  PanelHeader,
  stateIcon,
  StatusBadge,
} from "./dashboard-primitives.js";
import { veilPolicyIdentity } from "./dashboard-state.js";
import { AuthenticatedArtifact, AuthenticatedVideo, RecordingPlaylist } from "./evidence-media.js";
import { deriveRecordingTimeline, deriveRecoveryTimeline } from "./recording-timeline.js";

const terminalStates: RunState[] = [
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
];

export function ReportView({
  runId,
  onBack,
  onOpenReport,
}: {
  runId: string;
  onBack: () => void;
  onOpenReport: (id: string) => void;
}) {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<Report>(`/runs/${runId}`)
      .then(setReport)
      .catch((cause) => setError(message(cause)));
  }, [runId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!report || !terminalStates.includes(report.run.state)) load();
    }, 1_500);
    return () => clearInterval(timer);
  }, [load, report]);

  if (!report) return <PageSkeleton />;
  const run = report.run;
  const currentAttempt = report.currentAttempt ?? report.attempts.at(-1);
  const allAssertions = report.steps.flatMap((step) => step.assertions);
  const passed = allAssertions.filter((assertion) => assertion.status === "passed").length;
  const failed = allAssertions.filter((assertion) => assertion.status === "failed").length;
  const screenshots = report.artifacts.filter(
    (artifact) => artifact.kind === "screenshot" && artifact.availability === "available",
  );
  const videos = report.artifacts.filter(
    (artifact) => artifact.kind === "video" && artifact.availability === "available",
  );
  const recordingTimeline = deriveRecordingTimeline(report);
  const recoveryTimeline = deriveRecoveryTimeline(report);
  const visuallyRedacted = report.artifacts.some(
    (artifact) => artifact.observation?.visualRedaction === "protected-elements-masked",
  );
  const degradedEvidence = report.artifacts.filter(
    (artifact) => artifact.availability !== "available",
  );
  const privacyEvents = report.events.filter((event) => event.type === "privacy.state_changed");
  const protectedTransactionEvents = report.events.filter((event) =>
    [
      "privacy.operation_completed",
      "privacy.operation_failed",
      "privacy.credential_compromised",
    ].includes(event.type),
  );
  const diagnostics = report.events.filter((event) => event.type.startsWith("diagnostic."));
  const policyEvents = report.events.filter((event) => event.type === "policy.rejected");
  const fatalPolicy = [...policyEvents]
    .reverse()
    .find((event) => event.payload.disposition !== "blocked_subresource");
  const failedAssertion = allAssertions.find((assertion) => assertion.status === "failed");
  const failedStep = report.steps.find(
    (step) =>
      step.action.status === "failed" ||
      step.readiness?.status === "failed" ||
      step.assertions.some((assertion) => assertion.status === "failed"),
  );
  const failureMessage =
    report.failure?.message ??
    (fatalPolicy
      ? `${String(fatalPolicy.payload.message ?? "Request blocked by execution policy")}${fatalPolicy.payload.target ? ` · ${String(fatalPolicy.payload.target)}` : ""}`
      : (currentAttempt?.error ??
        failedAssertion?.error ??
        failedStep?.action.error ??
        failedStep?.readiness?.error));
  const classification = run.outcomeClassification;
  const classificationSummary = outcomeSummary(classification, failureMessage);
  const duration =
    currentAttempt?.startedAt && currentAttempt.completedAt
      ? new Date(currentAttempt.completedAt).getTime() -
        new Date(currentAttempt.startedAt).getTime()
      : undefined;

  const cancelRun = async () => {
    setBusy("cancel");
    setError("");
    try {
      await post(`/runs/${runId}/cancel`);
      load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <button className="back-button" onClick={onBack}>
        ← Back to runs
      </button>
      <section className={`report-hero report-${run.state}`}>
        <div className="outcome-icon">{stateIcon(run.state, 26)}</div>
        <div className="report-heading">
          <div className="eyebrow">RUN #{run.id.slice(0, 8)}</div>
          <h1>{run.planSnapshot.name}</h1>
          <p>{run.planSnapshot.objective}</p>
        </div>
        <div className="report-actions">
          {!terminalStates.includes(run.state) && (
            <button
              className="secondary-button danger"
              onClick={() => void cancelRun()}
              disabled={!!busy}
            >
              <Square size={14} /> Cancel
            </button>
          )}
        </div>
      </section>
      {error && (
        <div className="global-error">
          <AlertTriangle size={16} /> {error}
        </div>
      )}
      <section className="panel">
        <PanelHeader
          title="Veil privacy"
          kicker={`${report.veil.effectiveProfile.replaceAll("_", " ").toUpperCase()} · ${report.veil.status.toUpperCase()}`}
        />
        <div className="diagnostics">
          <div>
            <ShieldCheck size={15} />
            <div>
              <strong>Effective policy · {veilPolicyIdentity(report.veil.policyDigest)}</strong>
              <span>
                {report.veil.timeline.length} lifecycle entries · {report.veil.gaps.length} capture
                gaps
              </span>
            </div>
          </div>
          {report.veil.findings.map((finding, index) => (
            <div key={`${finding.code}-${index}`}>
              <AlertTriangle size={15} />
              <div>
                <strong>
                  {finding.code} · {finding.severity}
                </strong>
                <span>{finding.remediation}</span>
                {finding.channel && (
                  <code>
                    {finding.channel} · {finding.reasonCode}
                  </code>
                )}
              </div>
            </div>
          ))}
          {report.veil.gaps.map((gap, index) => (
            <div key={`${gap.startedAt}-${index}`}>
              <Eye size={15} />
              <div>
                <strong>Capture withheld · {gap.reasonCode}</strong>
                <span>{gap.remediation}</span>
              </div>
            </div>
          ))}
          {!report.veil.findings.length && !report.veil.gaps.length && (
            <div className="clean-signal">
              <ShieldCheck size={20} />
              <strong>Veil verified</strong>
              <span>No privacy finding or capture gap was recorded.</span>
            </div>
          )}
        </div>
      </section>
      <section className="panel">
        <PanelHeader
          title="Praxis interactions"
          kicker={`${report.praxis.transactions.length} TRANSACTIONS · ${report.praxis.findings.length} FINDINGS`}
        />
        <div className="diagnostics">
          {report.praxis.transactions.map((transaction) => (
            <div key={transaction.transactionId}>
              <Activity size={15} />
              <div>
                <strong>
                  {transaction.operationId} · {transaction.result.status}
                </strong>
                <span>
                  {transaction.result.report.summary} · mutation{" "}
                  {transaction.result.mutationOutcome} ·{" "}
                  {Math.round(transaction.result.timing.totalMs)} ms
                </span>
                {transaction.result.mutationOutcome === "unknown" && (
                  <code>Do not retry without reconciliation</code>
                )}
              </div>
            </div>
          ))}
          {report.praxis.findings.map(({ id, finding }) => (
            <div key={id}>
              <AlertTriangle size={15} />
              <div>
                <strong>
                  {finding.code} · {finding.severity}
                </strong>
                <span>{finding.remediation}</span>
              </div>
            </div>
          ))}
          {!report.praxis.transactions.length && !report.praxis.findings.length && (
            <div className="clean-signal">
              <Eye size={20} />
              <strong>
                {report.praxis.status === "complete"
                  ? "No Praxis records"
                  : "Praxis records unavailable"}
              </strong>
              <span>
                Legacy runs remain fully observable through their existing events and diagnostics.
              </span>
            </div>
          )}
        </div>
      </section>
      {report.integrity.status === "failed" && (
        <section className="failure-summary">
          <div className="failure-summary-icon">
            <AlertTriangle size={22} />
          </div>
          <div>
            <span className="eyebrow">OBSERVATION INTEGRITY</span>
            <h2>Persisted run evidence is incomplete</h2>
            <p>
              {report.integrity.issues
                .map((issue) => `${issue.code}: ${issue.message}`)
                .join(" · ")}
            </p>
          </div>
        </section>
      )}
      {(visuallyRedacted || privacyEvents.length > 0) && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon">
            <ShieldCheck size={22} />
          </div>
          <div>
            <span className="eyebrow">PROTECTED EVIDENCE</span>
            <h2>Evidence collection was controlled through protected intervals</h2>
            <p>
              Recording and trace segments stop at Privacy Gate boundaries. Suppressed or uncertain
              evidence is shown as a gap or metadata-only quarantine record.
            </p>
          </div>
        </section>
      )}
      {protectedTransactionEvents.length > 0 && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon">
            <ShieldCheck size={22} />
          </div>
          <div>
            <span className="eyebrow">PROTECTED OPERATIONS</span>
            <h2>Atomic privacy outcomes</h2>
            {protectedTransactionEvents.map((event) => (
              <div className="privacy-operation-facts" key={`${event.attemptId}-${event.sequence}`}>
                <strong>
                  {String(event.payload.operationId ?? "protected operation")} ·{" "}
                  {String(
                    (event.payload.result as Record<string, unknown> | undefined)?.status ??
                      event.payload.status ??
                      event.payload.code ??
                      "completed",
                  )}
                </strong>
                {Boolean(event.payload.result) && (
                  <span>
                    {[
                      "mutation",
                      "extraction",
                      "persistence",
                      "capsule",
                      "reconciliation",
                      "continuation",
                      "evidence",
                      "credentialSecurity",
                    ]
                      .map(
                        (fact) =>
                          `${fact}: ${String((event.payload.result as Record<string, unknown>)[fact] ?? "unknown")}`,
                      )
                      .join(" · ")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {run.resolvedAt && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon">
            <CheckCircle2 size={22} />
          </div>
          <div>
            <span className="eyebrow">RESOLVED</span>
            <h2>A later exact rerun passed</h2>
            <p>
              This historical result remains unchanged for auditability, but it no longer needs
              attention.
            </p>
          </div>
          {run.resolvedByRunId && (
            <button className="secondary-button" onClick={() => onOpenReport(run.resolvedByRunId!)}>
              Open passing run <ArrowRight size={15} />
            </button>
          )}
        </section>
      )}
      {run.confirmationRunId && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon">
            <LoaderCircle className="spin" size={22} />
          </div>
          <div>
            <span className="eyebrow">CONFIRMATION</span>
            <h2>A timing-controlled confirmation run is available</h2>
            <p>
              The original observation remains unchanged. Open the linked run before making a
              product-level conclusion.
            </p>
          </div>
          <button className="secondary-button" onClick={() => onOpenReport(run.confirmationRunId!)}>
            Open confirmation <ArrowRight size={15} />
          </button>
        </section>
      )}
      {run.confirmationOfRunId && (
        <section className="resolution-summary">
          <div className="resolution-summary-icon">
            <Clock3 size={22} />
          </div>
          <div>
            <span className="eyebrow">CONFIRMATION RUN</span>
            <h2>This run rechecks a timing-sensitive observation</h2>
            <p>The original evidence remains available and is never replaced by this result.</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => onOpenReport(run.confirmationOfRunId!)}
          >
            Open original <ArrowRight size={15} />
          </button>
        </section>
      )}
      {["failed", "timed_out", "infrastructure_error"].includes(run.state) && !run.resolvedAt && (
        <section className="failure-summary">
          <div className="failure-summary-icon">
            <AlertTriangle size={22} />
          </div>
          <div>
            <span className="eyebrow">WHAT NEEDS ATTENTION</span>
            <h2>{classificationSummary.title}</h2>
            <p>{classificationSummary.copy}</p>
          </div>
        </section>
      )}

      <section className="report-metrics">
        <div>
          <span>Outcome</span>
          <StatusBadge state={run.state} resolved={Boolean(run.resolvedAt)} />
        </div>
        <div>
          <span>Phase</span>
          <strong>{run.currentPhase ?? run.phase ?? run.state}</strong>
        </div>
        <div>
          <span>Assertions</span>
          <strong>
            {passed}
            <small> passed</small>
            {failed > 0 && <em>{failed} failed</em>}
          </strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{duration === undefined ? "—" : formatDuration(duration)}</strong>
        </div>
        <div>
          <span>Viewport</span>
          <strong>
            {run.executionSnapshot.viewport.width} × {run.executionSnapshot.viewport.height}
          </strong>
        </div>
        <div>
          <span>Evidence</span>
          <strong>
            {report.artifacts.length}
            <small> artifacts</small>
          </strong>
        </div>
        {degradedEvidence.length > 0 && (
          <div>
            <span>Evidence health</span>
            <strong>
              {degradedEvidence.length}
              <small> degraded</small>
            </strong>
          </div>
        )}
      </section>

      <section className="report-layout">
        <div className="report-main">
          <div className="panel">
            <PanelHeader
              title="Execution timeline"
              kicker={`${run.planSnapshot.steps.length} PLANNED STEPS`}
            />
            <div className="timeline">
              {run.planSnapshot.steps.map((step, index) => {
                const result = report.steps.find((candidate) => candidate.stepId === step.id);
                const failure =
                  result &&
                  (result.action.status === "failed" ||
                    result.readiness?.status === "failed" ||
                    result.assertions.some((assertion) => assertion.status === "failed"));
                const pass = result && !failure && result.action.status === "passed";
                return (
                  <div
                    className={`timeline-step ${failure ? "step-failed" : pass ? "step-passed" : "step-waiting"}`}
                    key={step.id}
                  >
                    <div className="step-rail">
                      <span>
                        {failure ? <X size={14} /> : pass ? <Check size={14} /> : index + 1}
                      </span>
                    </div>
                    <div className="step-body">
                      <div>
                        <strong>{step.title}</strong>
                        <code>{step.action.type}</code>
                      </div>
                      <span>
                        {failure
                          ? String(
                              result?.action.error ??
                                result?.readiness?.error ??
                                result?.assertions.find(
                                  (assertion) => assertion.status === "failed",
                                )?.error ??
                                "Step failed",
                            )
                          : pass
                            ? "Completed successfully"
                            : "Not evaluated"}
                      </span>
                      {step.after && (
                        <div className="assertion-line">
                          <LoaderCircle size={14} /> Readiness ·{" "}
                          {step.after.conditions
                            .map((condition) => condition.type)
                            .join(step.after.mode === "all" ? " + " : " or ")}{" "}
                          · up to {Math.round(step.after.timeoutMs / 1000)}s
                        </div>
                      )}
                      {step.captureIntent === "transient" && (
                        <div className="assertion-line">
                          <AlertTriangle size={14} /> Transient observation · not completed-state
                          proof
                        </div>
                      )}
                      {(result?.assertions ?? []).map((assertion) => (
                        <div
                          className={`assertion-line assertion-${assertion.status}`}
                          key={assertion.index}
                        >
                          {assertion.status === "passed" ? (
                            <CheckCircle2 size={14} />
                          ) : (
                            <XCircle size={14} />
                          )}
                          {assertion.type} assertion · {assertion.status}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="panel">
            <PanelHeader title="Captured evidence" kicker="ARTIFACTS" />
            {recordingTimeline.length > 0 ? (
              <RecordingPlaylist entries={recordingTimeline} artifacts={report.artifacts} />
            ) : (
              videos.map((artifact) => <AuthenticatedVideo artifact={artifact} key={artifact.id} />)
            )}
            {screenshots.length ? (
              <div className="evidence-grid">
                {screenshots.map((artifact) => (
                  <AuthenticatedArtifact artifact={artifact} image key={artifact.id} />
                ))}
              </div>
            ) : (
              <EmptyBlock
                icon={<Image />}
                title="No screenshots available"
                copy="Evidence appears as the worker finalizes artifacts."
              />
            )}
            <div className="artifact-strip">
              {report.artifacts
                .filter((a) => a.kind !== "screenshot" && a.kind !== "video")
                .map((artifact) => (
                  <AuthenticatedArtifact artifact={artifact} key={artifact.id} />
                ))}
            </div>
          </div>
        </div>
        <aside className="report-side">
          <div className="panel">
            <PanelHeader title="Run context" kicker="IMMUTABLE SNAPSHOT" />
            <dl className="context-list">
              <div>
                <dt>Access scope</dt>
                <dd>Flow destinations only</dd>
              </div>
              <div>
                <dt>Starting origin</dt>
                <dd>{run.environmentSnapshot.baseOrigin}</dd>
              </div>
              <div>
                <dt>Browser</dt>
                <dd>Chrome / {run.executionSnapshot.browser}</dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd>{run.executionSnapshot.seed}</dd>
              </div>
              <div>
                <dt>Attempt</dt>
                <dd>{currentAttempt?.attemptNumber ?? "—"}</dd>
              </div>
              <div>
                <dt>Capture epochs</dt>
                <dd>
                  {recoveryTimeline.filter((entry) => entry.type === "capture_epoch").length || 1}
                </dd>
              </div>
              {run.rerunOfRunId && (
                <div>
                  <dt>Rerun of</dt>
                  <dd>#{run.rerunOfRunId.slice(0, 8)}</dd>
                </div>
              )}
              {run.resolvedByRunId && (
                <div>
                  <dt>Resolved by</dt>
                  <dd>#{run.resolvedByRunId.slice(0, 8)}</dd>
                </div>
              )}
            </dl>
            {recoveryTimeline.length > 0 && (
              <div className="privacy-state-list">
                {recoveryTimeline.map((entry) =>
                  entry.type === "capture_epoch" ? (
                    <div key={entry.id}>
                      <strong>Capture epoch {entry.epoch}</strong>
                      <span>
                        {entry.startReason.replaceAll("_", " ")} →{" "}
                        {entry.endReason.replaceAll("_", " ")}
                      </span>
                    </div>
                  ) : (
                    <div key={entry.id}>
                      <strong>Checkpoint · {entry.boundary.replaceAll("_", " ")}</strong>
                      <span>
                        {entry.reasonCode ??
                          entry.continuedAtStepId ??
                          `epoch ${entry.captureEpoch}`}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
          <div className="panel">
            <PanelHeader
              title="Diagnostics"
              kicker={`${diagnostics.length + policyEvents.length + report.praxis.transactions.length} SIGNALS`}
            />
            <div className="diagnostics">
              {policyEvents.map((event) => (
                <div key={event.id}>
                  <ShieldCheck size={15} />
                  <div>
                    <strong>
                      {event.payload.disposition === "blocked_subresource"
                        ? "OPTIONAL RESOURCE BLOCKED"
                        : "POLICY REJECTION"}
                      {event.payload.resourceType ? ` · ${String(event.payload.resourceType)}` : ""}
                    </strong>
                    <span>{String(event.payload.message ?? "")}</span>
                    {Boolean(event.payload.target) && <code>{String(event.payload.target)}</code>}
                  </div>
                </div>
              ))}
              {diagnostics.map((event) => (
                <div key={event.id}>
                  <TerminalSquare size={15} />
                  <div>
                    <strong>{event.type.replace("diagnostic.", "")}</strong>
                    <span>{String(event.payload.message ?? "")}</span>
                    {Boolean(event.payload.url) && <code>{String(event.payload.url)}</code>}
                  </div>
                </div>
              ))}
              {!diagnostics.length &&
                !policyEvents.length &&
                !report.praxis.transactions.length && (
                  <div className="clean-signal">
                    <ShieldCheck size={20} />
                    <strong>Clean session</strong>
                    <span>No console, page, policy, Praxis, or failed-request signals.</span>
                  </div>
                )}
            </div>
          </div>
        </aside>
      </section>
    </>
  );
}

function outcomeSummary(classification: Run["outcomeClassification"], detail?: string) {
  switch (classification) {
    case "readiness_timeout":
      return {
        title: "The configured ready state was not observed",
        copy: `${detail ?? "The readiness condition timed out."} A confirmation may show that the timeout is reproducible, but it cannot validate the expectation or prove a product defect.`,
      };
    case "transient_observation":
      return {
        title: "Scry captured an intentional intermediate state",
        copy: "This evidence describes a moment in time and cannot prove the completed application state.",
      };
    case "inconclusive_plan":
      return {
        title: "The plan did not collect conclusive proof",
        copy: "The observation is accurate, but the Flow did not define enough readiness or assertions for a product-level conclusion.",
      };
    case "policy_failure":
      return {
        title: "Execution was blocked by policy",
        copy: detail ?? "Review the approved origins and execution boundaries.",
      };
    case "infrastructure_failure":
      return {
        title: "The browser worker could not complete the run",
        copy:
          detail ?? "The failure occurred in Scry infrastructure rather than the tested product.",
      };
    case "execution_timeout":
      return {
        title: "The run exceeded its execution budget",
        copy: detail ?? "The complete journey did not finish within its maximum duration.",
      };
    case "confirmed_product_failure":
      return {
        title: "The expected behavior failed consistently",
        copy:
          detail ??
          "Readiness succeeded and a timing-controlled confirmation reproduced the semantic assertion failure.",
      };
    case "non_reproduced_failure":
      return {
        title: "The original observation did not reproduce",
        copy: "The confirmation passed with a bounded readiness window. Treat the original result as timing-sensitive.",
      };
    case "assertion_failure":
      return {
        title: "A defined expectation was not met",
        copy: detail ?? "Review the failed assertion and stabilized evidence.",
      };
    default:
      return {
        title: "The expected behavior was not observed",
        copy: detail ?? "Review the execution timeline and evidence.",
      };
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
