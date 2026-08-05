import {
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  Copy,
  Gauge,
  KeyRound,
  PlugZap,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  api,
  post,
  remove,
  type Calibration,
  type Credential,
  type CredentialIncident,
  type McpAccessToken,
  type Project,
} from "../../infrastructure/api/client.js";
import { Modal } from "../../shared/components/dashboard-controls.js";
import { EmptyBlock, PageTitle } from "../../shared/components/dashboard-primitives.js";
import { publicConfig } from "../../infrastructure/config/runtime-config.js";

export function Settings({ projectId }: { projectId: string }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [incidents, setIncidents] = useState<CredentialIncident[]>([]);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void Promise.all([
      api<Credential[]>(`/projects/${projectId}/credentials`),
      api<Calibration[]>(`/projects/${projectId}/calibrations`),
      api<CredentialIncident[]>(`/projects/${projectId}/credential-incidents`),
    ])
      .then(([nextCredentials, nextCalibrations, nextIncidents]) => {
        setCredentials(nextCredentials);
        setCalibrations(nextCalibrations);
        setIncidents(nextIncidents);
      })
      .catch((cause) => setError(message(cause)));
  }, [projectId]);

  useEffect(load, [load]);

  const deleteCredential = async (credential: Credential) => {
    if (
      !window.confirm(
        `Remove “${credential.name}”? Flows using it will need another credential before they can run.`,
      )
    )
      return;
    setError("");
    try {
      await remove(`/credentials/${credential.id}`);
      load();
    } catch (cause) {
      setError(message(cause));
    }
  };

  const decideCalibration = async (calibration: Calibration, decision: "approve" | "reject") => {
    if (!calibration.attestationId) return;
    setError("");
    try {
      const session = await post<{ agentSessionId: string }>(
        `/missions/${calibration.missionId}/agent-sessions`,
        {
          provider: "human",
          instructionSnapshot: `${decision} calibration`,
          idempotencyKey: `web-calibration-${crypto.randomUUID()}`,
        },
      );
      await post(
        `/calibrations/${calibration.id}/attestations/${calibration.attestationId}/${decision}`,
        {
          missionId: calibration.missionId,
          objectiveId: calibration.objectiveId,
          agentSessionId: session.agentSessionId,
          confirmedUserAuthorized: true,
        },
      );
      load();
    } catch (cause) {
      setError(message(cause));
    }
  };

  return (
    <>
      <PageTitle
        eyebrow="PROJECT SCOPE"
        title="Project settings"
        copy="Defaults applied to new Flow runs in this project."
      />
      <section className="panel policy-defaults">
        <div>
          <span className="eyebrow">EXECUTION DEFAULTS</span>
          <h3>Configured inside each Flow</h3>
          <p>
            Every Flow owns its related URLs and ordered Sequence. Scry generates its safety
            boundaries automatically and preserves them with every report.
          </p>
        </div>
        <div className="policy-facts">
          <span>
            <Check size={14} /> Chromium
          </span>
          <span>
            <Check size={14} /> 1280 × 720
          </span>
          <span>
            <Check size={14} /> Flow-scoped access
          </span>
        </div>
      </section>
      <section className="panel credential-settings">
        <div className="credential-settings-head">
          <div>
            <span className="eyebrow">PROTECTED TEST INFORMATION</span>
            <h3>Test credentials</h3>
            <p>Passwords, private test accounts, and API values used by this project’s Flows.</p>
          </div>
          <button className="primary-button" onClick={() => setDialog(true)}>
            <Plus size={15} /> Add credential
          </button>
        </div>
        {error && (
          <div className="form-error">
            <AlertTriangle size={15} /> {error}
          </div>
        )}
        <div className="credential-list">
          {credentials.map((credential) => (
            <div key={credential.id}>
              <span className="credential-icon">
                <KeyRound size={17} />
              </span>
              <div>
                <strong>{credential.name}</strong>
                <small>Value protected · updated {relativeTime(credential.updatedAt)}</small>
              </div>
              <span className="credential-value">••••••••••••</span>
              <button
                className="icon-button"
                aria-label={`Remove ${credential.name}`}
                onClick={() => void deleteCredential(credential)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {!credentials.length && (
            <EmptyBlock
              icon={<KeyRound />}
              title="No test credentials yet"
              copy="Add protected information once, then select it safely inside any Flow."
            />
          )}
        </div>
      </section>
      <section className="panel credential-settings">
        <div className="credential-settings-head">
          <div>
            <span className="eyebrow">PRIVACY CALIBRATION</span>
            <h3>Protected-operation contracts</h3>
            <p>
              Structural fingerprints and adapter choices remain inactive until an owner or admin
              approves the immutable revision.
            </p>
          </div>
        </div>
        <div className="credential-list">
          {calibrations.map((calibration) => (
            <div key={calibration.id}>
              <span className="credential-icon">
                <ShieldCheck size={17} />
              </span>
              <div>
                <strong>{calibration.name}</strong>
                <small>
                  {calibration.operationId} · revision {calibration.revision} · {calibration.status}{" "}
                  · session {calibration.sessionState ?? "pending"}
                  {calibration.safeDiagnostics?.phase
                    ? ` · ${calibration.safeDiagnostics.phase}`
                    : ""}
                  {calibration.safeDiagnostics?.stepId
                    ? ` · step ${calibration.safeDiagnostics.stepId}`
                    : ""}
                  {calibration.safeDiagnostics?.code
                    ? ` · ${calibration.safeDiagnostics.code}`
                    : ""}
                </small>
              </div>
              {calibration.status === "draft" && calibration.attestationId && (
                <div className="credential-actions">
                  <button
                    className="secondary-button"
                    onClick={() => void decideCalibration(calibration, "reject")}
                  >
                    Reject
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void decideCalibration(calibration, "approve")}
                  >
                    Approve
                  </button>
                </div>
              )}
            </div>
          ))}
          {!calibrations.length && (
            <EmptyBlock
              icon={<ShieldCheck />}
              title="No calibration contracts"
              copy="Agents may create disposable calibration drafts through MCP; approval remains here."
            />
          )}
        </div>
      </section>
      <section className="panel credential-settings">
        <div className="credential-settings-head">
          <div>
            <span className="eyebrow">CREDENTIAL RESPONSE</span>
            <h3>Credential incidents</h3>
            <p>
              Compromised credentials never reactivate. Failed or timed-out revocation requires
              manual action.
            </p>
          </div>
        </div>
        <div className="credential-list">
          {incidents.map((incident) => (
            <div key={incident.id}>
              <span className="credential-icon">
                <AlertTriangle size={17} />
              </span>
              <div>
                <strong>{incident.operationId}</strong>
                <small>
                  {incident.state} · {incident.reasonCode} ·{" "}
                  {incident.safeDiagnostics?.code ?? "INCIDENT_RECORDED"} ·{" "}
                  {relativeTime(incident.createdAt)}
                </small>
                {incident.safeDiagnostics?.manualAction && (
                  <small>
                    Required action: revoke this credential in the provider administration console.
                  </small>
                )}
              </div>
            </div>
          ))}
          {!incidents.length && (
            <EmptyBlock
              icon={<ShieldCheck />}
              title="No credential incidents"
              copy="Revocation outcomes and manual follow-up will appear here."
            />
          )}
        </div>
      </section>
      {dialog && (
        <CredentialDialog
          projectId={projectId}
          onClose={() => setDialog(false)}
          onSaved={() => {
            setDialog(false);
            load();
          }}
        />
      )}
    </>
  );
}

function CredentialDialog({
  projectId,
  onClose,
  onSaved,
  getContext,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (credential: Credential) => void;
  getContext?: () => Promise<{ missionId: string; objectiveId: string; agentSessionId: string }>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (!getContext)
        throw new Error("Select a Mission objective before creating protected information.");
      const context = await getContext();
      const credential = await post<Credential>(`/projects/${projectId}/credentials`, {
        ...context,
        name: name.trim(),
        value,
      });
      onSaved(credential);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this credential.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add protected information"
      subtitle="Available only to this project’s controlled test runs."
      onClose={onClose}
    >
      <form className="stack-form credential-form" onSubmit={submit}>
        <p className="modal-description">
          Save a test login, token, or other private value once. Scry can use it during a run
          without showing it in the Flow or report.
        </p>
        <label>
          <span>Credential name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Vitract test account password"
            minLength={2}
            maxLength={80}
            required
          />
          <small>Use a name your team will recognize. Do not put the secret itself here.</small>
        </label>
        <label>
          <span>Protected value</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Enter the actual value"
            autoComplete="new-password"
            required
          />
          <small>This value is encrypted before storage and is never returned by the API.</small>
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            <KeyRound size={18} />
            {saving ? "Saving…" : "Save credential"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
