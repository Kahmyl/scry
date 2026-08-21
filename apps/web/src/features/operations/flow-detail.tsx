import { ArrowLeft, CheckCircle2, Code2, FileCode2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type FlowDetail } from "../../infrastructure/api/client.js";
import {
  EmptyBlock,
  PageSkeleton,
  PageTitle,
} from "../../shared/components/dashboard-primitives.js";

export function FlowDetailView({
  flowId,
  kind,
  onBack,
}: {
  flowId: string;
  kind: "draft" | "published";
  onBack: (missionId?: string) => void;
}) {
  const [flow, setFlow] = useState<FlowDetail>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<FlowDetail>(kind === "draft" ? `/flow-drafts/${flowId}` : `/flows/${flowId}`)
      .then((value) => {
        if (active) setFlow(value);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [flowId, kind]);

  if (error)
    return (
      <div className="panel empty-large">
        <EmptyBlock icon={<FileCode2 />} title="Flow unavailable" copy={error} />
      </div>
    );
  if (!flow) return <PageSkeleton />;
  const state = flow.lifecycleState ?? flow.state ?? kind;

  return (
    <div className="flow-detail">
      <button
        className="back-button mission-back"
        onClick={() =>
          onBack(flow.missionId ?? flow.originMissionId ?? flow.missionLinks?.[0]?.missionId)
        }
      >
        <ArrowLeft size={15} /> Back to Flows
      </button>
      <PageTitle
        eyebrow={kind === "draft" ? "AUTHORED FLOW DRAFT" : "PUBLISHED FLOW"}
        title={flow.name}
        copy={flow.content?.objective ?? flow.description ?? "No objective added."}
      />
      <section className="panel flow-detail-summary">
        <div>
          <span>Lifecycle</span>
          <strong className={kind === "published" ? "ready-tag" : "draft-tag"}>
            {state.replaceAll("_", " ")}
          </strong>
        </div>
        <div>
          <span>Version</span>
          <strong>v{flow.version}</strong>
        </div>
        <div>
          <span>Steps</span>
          <strong>{flow.plan?.steps?.length ?? 0}</strong>
        </div>
        <div>
          <span>Environment</span>
          <strong>
            {flow.environmentId ? flow.environmentId.slice(0, 8) : "Published policy"}
          </strong>
        </div>
      </section>
      <section className="panel flow-detail-plan">
        <div className="panel-heading">
          <div>
            <small>AUTHORED DEFINITION</small>
            <h2>Ordered steps</h2>
          </div>
        </div>
        <div className="flow-step-list">
          {(flow.plan?.steps ?? []).map((step, index) => (
            <article className="flow-step" key={step.id ?? index}>
              <div className="flow-step-index">{index + 1}</div>
              <div className="flow-step-body">
                <div className="flow-step-title">
                  <strong>{step.title ?? step.id ?? `Step ${index + 1}`}</strong>
                  <span>{step.action?.type ?? "operation"}</span>
                </div>
                <ActionSummary action={step.action} />
                {!!step.assertions?.length && (
                  <div className="flow-step-effects">
                    <CheckCircle2 size={14} />
                    <span>
                      {step.assertions.length} expected effect
                      {step.assertions.length === 1 ? "" : "s"}
                    </span>
                  </div>
                )}
                {step.captureIntent === "transient" && (
                  <div className="flow-step-effects">
                    <ShieldCheck size={14} />
                    <span>Transient protected handling</span>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      {kind === "draft" && (
        <section className="panel flow-detail-authoring">
          <div>
            <Code2 size={16} />
            <strong>{flow.probes?.length ?? 0} probes</strong>
          </div>
          <div>
            <CheckCircle2 size={16} />
            <strong>
              {flow.compilations?.[0]?.status?.replaceAll("_", " ") ?? "Not compiled"}
            </strong>
          </div>
          <div>
            <FileCode2 size={16} />
            <strong>{flow.events?.length ?? 0} version events</strong>
          </div>
        </section>
      )}
    </div>
  );
}

function ActionSummary({
  action,
}: {
  action?: NonNullable<FlowDetail["plan"]>["steps"][number]["action"];
}) {
  if (!action) return <p>No action definition.</p>;
  if (action.type === "navigate")
    return (
      <p>
        Navigate to <code>{safeUrl(action.url)}</code>
      </p>
    );
  const target = action.target;
  const evidence = target?.preferredEvidence;
  return (
    <div className="flow-action-summary">
      <p>
        {target?.concept ? (
          <>
            Target <strong>{target.concept}</strong>
          </>
        ) : (
          "Semantic browser action"
        )}
      </p>
      {evidence && (
        <div className="flow-target-pills">
          {[...(evidence.roles ?? []), ...(evidence.names ?? []), ...(evidence.labels ?? [])].map(
            (item) => (
              <span key={item}>{item}</span>
            ),
          )}
        </div>
      )}
      {action.secretRef && (
        <p className="protected-reference">
          <ShieldCheck size={13} /> Protected reference configured
        </p>
      )}
    </div>
  );
}

function safeUrl(value?: string) {
  if (!value) return "configured destination";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "configured destination";
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
