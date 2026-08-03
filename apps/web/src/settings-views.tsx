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
  patch,
  post,
  remove,
  type Calibration,
  type Credential,
  type CredentialIncident,
  type Environment,
  type McpAccessToken,
  type Project,
  type VeilPreferenceRecord,
} from "./api.js";
import { Modal } from "./dashboard-controls.js";
import { EmptyBlock, PageTitle } from "./dashboard-primitives.js";
import { veilPolicyIdentity, veilTighteningOptions } from "./dashboard-state.js";
import { publicConfig } from "./runtime-config.js";

export function Settings({ projectId }: { projectId: string }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [incidents, setIncidents] = useState<CredentialIncident[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [veil, setVeil] = useState<VeilPreferenceRecord[]>([]);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void Promise.all([
      api<Credential[]>(`/projects/${projectId}/credentials`),
      api<Calibration[]>(`/projects/${projectId}/calibrations`),
      api<CredentialIncident[]>(`/projects/${projectId}/credential-incidents`),
      api<Environment[]>(`/projects/${projectId}/environments`),
    ])
      .then(async ([nextCredentials, nextCalibrations, nextIncidents, nextEnvironments]) => {
        const veilRecords = await Promise.all(
          nextEnvironments.map((environment) =>
            api<VeilPreferenceRecord>(`/environments/${environment.id}/veil`),
          ),
        );
        setCredentials(nextCredentials);
        setCalibrations(nextCalibrations);
        setIncidents(nextIncidents);
        setEnvironments(nextEnvironments);
        setVeil(veilRecords);
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

  const tightenVeil = async (environmentId: string, profile: "private" | "minimal_capture") => {
    setError("");
    try {
      const updated = await patch<VeilPreferenceRecord>(`/environments/${environmentId}/veil`, {
        profile,
        reasonCode: "VEIL_USER_REQUESTED_PRIVACY",
      });
      setVeil((current) =>
        current.map((record) => (record.environmentId === environmentId ? updated : record)),
      );
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
            <span className="eyebrow">VEIL PRIVACY</span>
            <h3>Effective capture profiles</h3>
            <p>
              Settings can only become stricter. Sensitive visual masking, structured-evidence
              sanitation, and unknown-evidence quarantine cannot be disabled.
            </p>
          </div>
        </div>
        <div className="credential-list">
          {environments.map((environment) => {
            const record = veil.find((candidate) => candidate.environmentId === environment.id);
            return (
              <div key={environment.id}>
                <span className="credential-icon">
                  <ShieldCheck size={17} />
                </span>
                <div>
                  <strong>
                    {environment.name} ·{" "}
                    {record?.effectivePolicy.profile.replaceAll("_", " ") ?? "loading"}
                  </strong>
                  <small>
                    {record
                      ? `Policy ${veilPolicyIdentity(record.effectivePolicy.digest)} · ${record.effectivePolicy.allowedOrigins.length} allowed origin(s) · ${record.effectivePolicy.leaseTtlMs} ms leases`
                      : "Loading effective policy"}
                  </small>
                </div>
                {record &&
                  veilTighteningOptions(record.effectivePolicy.profile).map((profile) => (
                    <button
                      key={profile}
                      className="secondary-button"
                      onClick={() => void tightenVeil(environment.id, profile)}
                    >
                      Use {profile.replaceAll("_", " ")}
                    </button>
                  ))}
              </div>
            );
          })}
          {!environments.length && (
            <EmptyBlock
              icon={<ShieldCheck />}
              title="No environments"
              copy="Veil preferences are environment-scoped and appear after an execution environment is created."
            />
          )}
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
                <>
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
                </>
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

export function Integrations() {
  const [tokens, setTokens] = useState<McpAccessToken[]>([]);
  const [revealedToken, setRevealedToken] = useState("");
  const [client, setClient] = useState<"codex" | "claude" | "generic">("codex");
  const [setupMethod, setSetupMethod] = useState<"app" | "cli">("app");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = new URL(publicConfig.mcpServerUrl, window.location.origin).toString();

  const load = useCallback(() => {
    void api<McpAccessToken[]>("/mcp-tokens")
      .then(setTokens)
      .catch((cause) => setError(message(cause)));
  }, []);

  useEffect(load, [load]);

  const createToken = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await post<McpAccessToken>("/mcp-tokens", {
        name: `${setupLabel(client, setupMethod)} connection`,
      });
      setRevealedToken(created.token ?? "");
      setTokens((current) => [created, ...current]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (token: McpAccessToken) => {
    if (!window.confirm(`Revoke “${token.name}”? Connected clients using it will stop working.`))
      return;
    try {
      const revoked = await remove<McpAccessToken>(`/mcp-tokens/${token.id}`);
      setTokens((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
    } catch (cause) {
      setError(message(cause));
    }
  };

  const tokenValue = revealedToken || "<YOUR_SCRY_MCP_TOKEN>";
  const claudeHosted = client === "claude" && setupMethod === "app";
  const instructions =
    client === "codex" && setupMethod === "app"
      ? `Open Settings → Plugins → MCPs → Add server\n\nName: Scry\nType: Streamable HTTP\nURL: ${endpoint}\nHeader key: Authorization\nHeader value: Bearer ${tokenValue}\n\nSave, then restart the app.`
      : client === "codex"
        ? `export SCRY_MCP_TOKEN="${tokenValue}"\n\ncodex mcp add scry --url ${endpoint} \\\n  --bearer-token-env-var SCRY_MCP_TOKEN`
        : client === "claude" && setupMethod === "cli"
          ? `claude mcp add --transport http scry ${endpoint} \\\n  --header "Authorization: Bearer ${tokenValue}"\n\n# In Claude Code, run /mcp to verify the connection.`
          : claudeHosted
            ? `Current Scry MCP URL:\n${endpoint}\n\nClaude / Claude Desktop support is coming with Scry's managed OAuth connection.\n\nWhen available:\n\n• Open Settings → Connectors\n• Select Add custom connector\n• Enter the Scry MCP URL shown here\n• Sign in to Scry and enable its tools\n\nScry access tokens are not accepted by this connection method. Use Claude Code CLI with an access token today.`
            : `Transport: Streamable HTTP\nEndpoint: ${endpoint}\nHeader: Authorization: Bearer ${tokenValue}`;

  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE INTEGRATION"
        title="Connect Scry to your AI client"
        copy="Use Scry from Codex, Claude, or any MCP-compatible client. The same tools and workspace permissions apply everywhere."
      />
      <section className="integration-hero panel">
        <div className="integration-mark">
          <PlugZap size={25} />
        </div>
        <div>
          <span className="eyebrow lime">MODEL CONTEXT PROTOCOL</span>
          <h2>One open protocol, not a Codex-only integration</h2>
          <p>
            Scry exposes standard MCP tools over Streamable HTTP for remote clients and stdio for
            local development. Your access token is scoped to this workspace and can be revoked at
            any time.
          </p>
        </div>
        <span className="integration-ready">
          <i /> Remote endpoint ready
        </span>
      </section>

      <section className="integration-layout">
        <div className="panel integration-setup">
          <div className="integration-section-head">
            <div>
              <span className="eyebrow">SETUP GUIDE</span>
              <h2>Choose your client</h2>
            </div>
            <span className="transport-pill">Streamable HTTP</span>
          </div>
          <div className="client-tabs">
            {(["codex", "claude", "generic"] as const).map((item) => (
              <button
                key={item}
                className={client === item ? "selected" : ""}
                onClick={() => {
                  setClient(item);
                  if (item === "generic") setSetupMethod("cli");
                  else setSetupMethod(item === "codex" ? "app" : "cli");
                }}
              >
                {clientLabel(item)}
              </button>
            ))}
          </div>
          {client !== "generic" && (
            <div className="setup-method-tabs" aria-label={`${clientLabel(client)} setup method`}>
              {(client === "codex"
                ? [
                    ["app", "ChatGPT / Codex app"],
                    ["cli", "CLI"],
                  ]
                : [
                    ["cli", "Claude Code CLI"],
                    ["app", "Claude / Desktop"],
                  ]
              ).map(([method, label]) => (
                <button
                  key={method}
                  className={setupMethod === method ? "selected" : ""}
                  onClick={() => setSetupMethod(method as "app" | "cli")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className={`mcp-endpoint-card ${claudeHosted ? "endpoint-incompatible" : ""}`}>
            <div className="mcp-endpoint-copy">
              <span className="eyebrow">YOUR SCRY MCP URL</span>
              <code>{endpoint}</code>
            </div>
            <button onClick={() => void navigator.clipboard.writeText(endpoint)}>
              <Copy size={14} /> Copy URL
            </button>
            <div className="mcp-endpoint-status">
              {claudeHosted ? (
                <>
                  <AlertTriangle size={15} />
                  <span>
                    <strong>Claude / Desktop connection coming soon</strong>This connection method
                    will be enabled when Scry’s managed OAuth support is ready.
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={15} />
                  <span>
                    <strong>Ready for this setup</strong>This client can connect to the local
                    Streamable HTTP endpoint.
                  </span>
                </>
              )}
            </div>
          </div>
          <ol className="integration-steps">
            {claudeHosted ? (
              <>
                <li>
                  <span>1</span>
                  <div>
                    <strong>Managed by Scry</strong>
                    <p>
                      Scry will provide the compatible OAuth connection automatically. There will be
                      no hosting or server setup for the user.
                    </p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Add the custom connector</strong>
                    <p>
                      When available, open Settings → Connectors → Add custom connector and enter
                      the Scry MCP URL shown above.
                    </p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Sign in and enable tools</strong>
                    <p>Sign in to Scry when Claude asks, then enable Scry from Search and tools.</p>
                  </div>
                </li>
              </>
            ) : (
              <>
                <li>
                  <span>1</span>
                  <div>
                    <strong>Create an access token</strong>
                    <p>
                      Scry shows the complete token once. Store it in your client’s secret or
                      environment configuration.
                    </p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Add the Scry MCP server</strong>
                    <p>{clientHelp(client, setupMethod)}</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Verify the connection</strong>
                    <p>
                      Ask your client to list Scry projects. It should call{" "}
                      <code>list_projects</code> and return only this workspace.
                    </p>
                  </div>
                </li>
              </>
            )}
          </ol>
          <div className="integration-command">
            <div>
              <span>{setupLabel(client, setupMethod)} setup</span>
              <button onClick={() => void navigator.clipboard.writeText(instructions)}>
                <Copy size={14} /> Copy
              </button>
            </div>
            <pre>{instructions}</pre>
          </div>
          {claudeHosted && (
            <div className="integration-auth-answer">
              <KeyRound size={17} />
              <div>
                <strong>Can I use a Scry access token here?</strong>
                <span>
                  No—not in the Claude/Claude Desktop connector. Use the{" "}
                  <button onClick={() => setSetupMethod("cli")}>Claude Code CLI</button> option with
                  an access token today. The Claude/Desktop option will use Scry sign-in when it
                  becomes available.
                </span>
              </div>
            </div>
          )}
          {revealedToken && !claudeHosted && (
            <div className="token-reveal">
              <AlertTriangle size={17} />
              <div>
                <strong>Copy this token now</strong>
                <span>
                  For security, Scry cannot show the full value again after you leave this page.
                </span>
              </div>
            </div>
          )}
          {error && (
            <div className="form-error">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
          {!claudeHosted && (
            <button
              className="primary-button integration-create"
              disabled={busy}
              onClick={() => void createToken()}
            >
              <KeyRound size={15} /> {busy ? "Creating…" : "Create access token"}
            </button>
          )}
        </div>

        <aside className="panel integration-tokens">
          <div className="integration-section-head">
            <div>
              <span className="eyebrow">SECURITY</span>
              <h2>Access tokens</h2>
            </div>
          </div>
          <p className="integration-aside-copy">
            Each client should have its own token so you can disconnect it without affecting the
            others.
          </p>
          <div className="integration-token-list">
            {tokens.map((token) => (
              <div key={token.id} className={token.revokedAt ? "revoked" : ""}>
                <div>
                  <strong>{token.name}</strong>
                  <code>{token.tokenPrefix}</code>
                  <small>
                    {token.revokedAt
                      ? "Revoked"
                      : token.lastUsedAt
                        ? `Last used ${relativeTime(token.lastUsedAt)}`
                        : "Never used"}
                  </small>
                </div>
                {!token.revokedAt && (
                  <button
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => void revokeToken(token)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {!tokens.length && (
              <EmptyBlock
                icon={<KeyRound />}
                title="No access tokens"
                copy="Create one when you are ready to connect a client."
              />
            )}
          </div>
        </aside>
      </section>
      <section className="integration-note panel">
        <ShieldCheck size={19} />
        <div>
          <strong>What “compatible” means</strong>
          <span>
            Any client that supports MCP Streamable HTTP and bearer headers can connect using a Scry
            access token. Clients that require OAuth will become available through Scry’s managed
            sign-in connection. Legacy SSE-only clients are not supported.
          </span>
        </div>
      </section>
    </>
  );
}

function clientLabel(client: "codex" | "claude" | "generic") {
  return client === "codex" ? "Codex" : client === "claude" ? "Claude" : "Other MCP client";
}

function setupLabel(client: "codex" | "claude" | "generic", method: "app" | "cli") {
  if (client === "codex") return method === "app" ? "Codex app" : "Codex CLI";
  if (client === "claude") return method === "app" ? "Claude / Desktop" : "Claude Code CLI";
  return "Other MCP client";
}

function clientHelp(client: "codex" | "claude" | "generic", method: "app" | "cli") {
  if (client === "codex" && method === "app")
    return "Use the Plugins → MCPs screen in the ChatGPT desktop app. Add the URL and authorization header shown below, save, then restart the app.";
  if (client === "codex")
    return "Run the command below, then use codex mcp list or /mcp to verify the server.";
  if (client === "claude")
    return "Run the command below in a terminal. Use /mcp in Claude Code to inspect the connection.";
  return "Add a remote MCP server using the endpoint and bearer header below. The transport must be Streamable HTTP.";
}

export function WorkspaceSettings({
  userEmail,
  projects,
}: {
  userEmail: string;
  projects: Project[];
}) {
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE SCOPE"
        title="Workspace settings"
        copy="Shared ownership, projects, and access across your Scry workspace."
      />
      <section className="settings-grid">
        <div className="panel settings-card">
          <div className="account-settings-icon">
            <Box size={20} />
          </div>
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h3>Scry workspace</h3>
            <p>The shared boundary containing your projects and durable test history.</p>
          </div>
          <dl>
            <div>
              <dt>Projects</dt>
              <dd>{projects.length}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>Local development</dd>
            </div>
          </dl>
        </div>
        <div className="panel settings-card">
          <div className="account-settings-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span className="eyebrow">MEMBERS & ACCESS</span>
            <h3>Workspace owner</h3>
            <p>Team roles and invitations will be managed at this scope.</p>
          </div>
          <dl>
            <div>
              <dt>Owner</dt>
              <dd>{userEmail}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>Administrator</dd>
            </div>
          </dl>
        </div>
      </section>
      <section className="panel settings-note">
        <AlertTriangle size={18} />
        <div>
          <strong>Team management is not enabled yet</strong>
          <span>
            The current local workspace has one owner. Invitations and role controls will appear
            here when multi-user access is enabled.
          </span>
        </div>
      </section>
    </>
  );
}

export function AccountSettings({ userEmail }: { userEmail: string }) {
  return (
    <>
      <PageTitle
        eyebrow="PERSONAL ACCOUNT"
        title="Account settings"
        copy="Your identity and sign-in details across every Scry workspace."
      />
      <section className="account-settings-grid">
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <Settings2 size={20} />
          </div>
          <div>
            <span className="eyebrow">PROFILE</span>
            <h3>Account identity</h3>
            <p>The email address associated with your Scry account.</p>
          </div>
          <div className="account-setting-row">
            <span>Email address</span>
            <strong>{userEmail}</strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <span className="eyebrow">AUTHENTICATION</span>
            <h3>Secure sign-in</h3>
            <p>
              Password, email verification, and connected sign-in providers are managed securely
              through Supabase.
            </p>
          </div>
          <div className="account-setting-row">
            <span>Status</span>
            <strong className="account-status">
              <i /> Active
            </strong>
          </div>
        </div>
        <div className="panel account-settings-card">
          <div className="account-settings-icon">
            <Gauge size={20} />
          </div>
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h3>Personal defaults</h3>
            <p>Display, time zone, and notification preferences belong only to your account.</p>
          </div>
          <div className="account-setting-row">
            <span>Time zone</span>
            <strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
          </div>
        </div>
      </section>
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
