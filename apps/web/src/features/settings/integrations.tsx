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
} from "../../infrastructure/api/client.js";
import { Modal } from "../../shared/components/dashboard-controls.js";
import { EmptyBlock, PageTitle } from "../../shared/components/dashboard-primitives.js";
import { publicConfig } from "../../infrastructure/config/runtime-config.js";

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
