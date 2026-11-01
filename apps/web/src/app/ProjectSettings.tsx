import { AlertTriangle, KeyRound, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { api, post } from "../infrastructure/api/index.js";
import { EmptyBlock, Modal, PageTitle } from "../shared/components/index.js";

type ProjectCredential = {
  id: string;
  referenceId: string;
  projectId: string;
  displayName: string;
  state: "active" | "expired" | "revoked" | "compromised";
  createdAt: string;
  expiresAt?: string;
};

export function ProjectSettings({ projectId }: { projectId: string }) {
  const [credentials, setCredentials] = useState<ProjectCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setCredentials(await api<ProjectCredential[]>(`/projects/${projectId}/protected-inputs`));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => void load(), [load]);

  return (
    <>
      <PageTitle
        eyebrow="PROJECT"
        title="Project settings"
        copy="Manage the credentials your agent can use when testing this project."
      />
      <section className="panel credential-settings">
        <div className="credential-settings-head">
          <div>
            <span className="eyebrow">PROTECTED INFORMATION</span>
            <h3>Credentials</h3>
            <p>
              Supply passwords, tokens and other protected inputs by name. Automatic evidence
              masking is best effort; review recordings and screenshots before sharing.
            </p>
          </div>
          <button className="primary-button" onClick={() => setDialogOpen(true)}>
            <Plus size={15} /> Add credential
          </button>
        </div>
        {error && (
          <div className="form-error" role="alert">
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
                <strong>{credential.displayName}</strong>
                <small>
                  {credential.state === "active"
                    ? "Active protected value"
                    : human(credential.state)}
                  {" · added "}
                  {new Date(credential.createdAt).toLocaleDateString()}
                </small>
              </div>
              <span className="credential-value">••••••••••••</span>
            </div>
          ))}
          {!loading && credentials.length === 0 && !error && (
            <EmptyBlock
              icon={<KeyRound />}
              title="No credentials yet"
              copy="Add a protected value here. An agent can suggest it by name, but must ask before using it for the first time."
            />
          )}
          {loading && <p className="modal-description">Loading protected credential metadata…</p>}
        </div>
      </section>
      <section className="panel settings-note">
        <KeyRound size={18} />
        <div>
          <strong>You remain in control of credential selection</strong>
          <span>
            Agents can see credential names and status, never their saved values. A similar name is
            only a candidate; the agent must ask you to select it before first use.
          </span>
        </div>
      </section>
      {dialogOpen && (
        <AddCredentialDialog
          projectId={projectId}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            void load();
          }}
        />
      )}
    </>
  );
}

function AddCredentialDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await post(`/projects/${projectId}/protected-inputs`, {
        displayName: displayName.trim(),
        value,
        expiresInSeconds: null,
        idempotencyKey: `web-browser-credential-${crypto.randomUUID()}`,
      });
      setValue("");
      onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add credential"
      subtitle="The protected value is encrypted before storage and is never returned by the API."
      onClose={onClose}
    >
      <form className="stack-form credential-form" onSubmit={submit}>
        <label>
          <span>Credential name</span>
          <input
            autoFocus
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Vitract test account password"
            maxLength={128}
            required
          />
          <small>Use a recognizable label without putting the secret itself in the name.</small>
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
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            <KeyRound size={17} /> {saving ? "Saving…" : "Save credential"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function human(value: string) {
  return value.replaceAll("_", " ");
}
