import {
  CheckCircle2,
  Copy,
  ExternalLink,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { api, remove } from "../../infrastructure/api/client.js";
import { publicConfig } from "../../infrastructure/config/runtime-config.js";
import { PageTitle } from "../../shared/components/dashboard-primitives.js";
import { AdvancedIntegrations } from "./integrations.js";
import "./connections.css";

type Connection = {
  id: string;
  clientName: string;
  workspaceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expired?: boolean;
};
type Connections = { available: boolean; connections: Connection[] };
type Client = "codex" | "claude" | "cursor";

export function Connections() {
  const [client, setClient] = useState<Client>("codex");
  const [state, setState] = useState<Connections>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [disconnecting, setDisconnecting] = useState<Connection>();
  const [checkMessage, setCheckMessage] = useState("");
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const connectionsHeading = useRef<HTMLHeadingElement | null>(null);
  const endpoint = new URL(publicConfig.mcpServerUrl, window.location.origin).href;
  const load = async (explicitCheck = false) => {
    setBusy(true);
    setError("");
    setCheckMessage("");
    try {
      setState(await api<Connections>("/integrations/connections"));
      if (explicitCheck)
        setCheckMessage(
          "Connection list refreshed. Only clients shown as Connected have verified access. This checks all your connections, not just the selected setup guide.",
        );
    } catch {
      setError("We couldn’t check your connections. Try again.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
    } catch {
      setError("Copy the connection address shown below, then return to your AI client.");
    }
  };
  const disconnect = async () => {
    if (!disconnecting) return;
    setBusy(true);
    setError("");
    try {
      await remove(`/integrations/connections/${disconnecting.id}`);
      setDisconnecting(undefined);
      await load();
    } catch {
      setError(
        "We couldn’t disconnect this client. Its access may still be active; please try again.",
      );
      setBusy(false);
    }
  };
  const cursorConfig = btoa(JSON.stringify({ url: endpoint }));
  return (
    <>
      <PageTitle
        eyebrow="CONNECTIONS"
        title="Bring Scry to your AI assistant"
        copy="Connect once. Ask for a test in your own words. Review the results here."
      />
      <section className="connection-setup panel" aria-labelledby="connection-heading">
        <div className="connection-heading">
          <span className="connection-icon">
            <PlugZap size={24} />
          </span>
          <div>
            <h2 id="connection-heading">Choose where you work</h2>
            <p>One Scry account. Your existing workspace permissions.</p>
          </div>
        </div>
        <div className="connection-clients" role="radiogroup" aria-label="AI client setup guides">
          {(
            [
              ["codex", "Codex / ChatGPT"],
              ["claude", "Claude"],
              ["cursor", "Cursor"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} data-active={client === value}>
              <input
                type="radio"
                name="scry-client-guide"
                value={value}
                checked={client === value}
                onChange={() => {
                  setClient(value);
                  setCopied(false);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {!state && !error && (
          <p className="connection-status" role="status">
            <LoaderCircle className="connection-spin" size={18} /> Checking connection setup…
          </p>
        )}
        {state?.available === false && (
          <p className="connection-notice">
            Guided sign-in is not enabled on this deployment yet. Existing connections still work;
            manual setup is available below.
          </p>
        )}
        {state?.available && (
          <>
            <ol className="connection-guide">
              <li>
                <span>1</span>
                <div>
                  <h3>
                    Add Scry to{" "}
                    {client === "codex"
                      ? "Codex or ChatGPT"
                      : client === "claude"
                        ? "Claude"
                        : "Cursor"}
                  </h3>
                  <p>
                    {client === "codex"
                      ? "In your client’s integration settings, add a custom remote MCP server using the address below."
                      : client === "claude"
                        ? "In Claude or Claude Desktop, open Settings → Connectors → Add custom connector. Name it Scry and paste the address below as the remote server URL. For a team account, your organization may need to enable custom connectors. In Claude Code, use the command below instead."
                        : "Use Add to Cursor, then review the connection in Cursor."}
                  </p>
                  {client === "cursor" ? (
                    <a
                      className="connection-primary"
                      href={`cursor://anysphere.cursor-deeplink/mcp/install?name=Scry&config=${encodeURIComponent(cursorConfig)}`}
                    >
                      Add to Cursor <ExternalLink size={15} />
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="connection-primary"
                      onClick={() => void copy()}
                    >
                      <Copy size={15} />
                      {copied ? "Address copied" : "Copy Scry address"}
                    </button>
                  )}
                  <code className="connection-address">{endpoint}</code>
                  {client === "claude" && (
                    <code className="connection-command">
                      claude mcp add --transport http scry {endpoint}
                    </code>
                  )}
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>Sign in and choose a workspace</h3>
                  <p>
                    Your client opens Scry for approval. Check the requested access, choose your
                    workspace and select Allow connection. No access-token copying is needed.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>Confirm, then start your first test</h3>
                  <p>
                    Ask your assistant: <q>Can you see my Scry projects?</q> Then describe what you
                    want tested and the application address. Use protected inputs for passwords, not
                    chat messages.
                  </p>
                  <button
                    type="button"
                    className="connection-secondary"
                    onClick={() => void load(true)}
                    disabled={busy}
                  >
                    <RefreshCw size={15} className={busy ? "connection-spin" : ""} />
                    Refresh connection list
                  </button>
                  {checkMessage && (
                    <p role="status" className="connection-refresh-result">
                      {checkMessage}
                    </p>
                  )}
                </div>
              </li>
            </ol>
            <p className="connection-footnote">
              <ShieldCheck size={17} /> Each client still requires your approval. An installation
              click alone does not verify access.
            </p>
            <details className="connection-package">
              <summary>Optional: add Scry’s testing workflow skills</summary>
              {endpoint !== "https://scry.giize.com/mcp" && (
                <p>
                  These downloads connect to hosted Scry at scry.giize.com, not this local or custom
                  server. Use the connection address above to test this server.
                </p>
              )}
              <p>
                These packages add setup, testing and report-review guidance where your client
                supports plugins. They do not contain credentials or replace sign-in.
              </p>
              <a href={`/plugins/scry-${client}.zip`} download>
                Download {client === "codex" ? "Codex" : client === "claude" ? "Claude" : "Cursor"}{" "}
                package
              </a>
              <p>
                Install the downloaded package using your client’s local-plugin instructions.
                ChatGPT uses the remote connector above; this package is not a ChatGPT marketplace
                listing.
              </p>
            </details>
          </>
        )}
        {error && (
          <p role="alert" className="connection-error">
            {error}{" "}
            <button type="button" onClick={() => void load()} disabled={busy}>
              Try again
            </button>
          </p>
        )}
      </section>
      <section className="connection-list" aria-labelledby="connected-heading">
        <div className="connection-section-title">
          <h2 id="connected-heading" ref={connectionsHeading} tabIndex={-1}>
            Your connections
          </h2>
          <p>Only clients you’ve authorized. Disconnecting does not delete your test results.</p>
        </div>
        {state && state.connections.length === 0 && (
          <div className="panel connection-empty">
            <PlugZap size={24} />
            <h3>No linked clients yet</h3>
            <p>Complete sign-in from your AI client, then check the connection status above.</p>
          </div>
        )}
        {state?.connections.map((connection) => (
          <article className="panel connection-row" key={connection.id}>
            <div>
              <h3>{connection.clientName}</h3>
              <p>{connection.workspaceName}</p>
              <span
                className={`connection-status ${connection.revokedAt || connection.expired ? "" : connection.lastUsedAt ? "connection-confirmed" : ""}`}
              >
                <CheckCircle2 size={15} />
                {connection.revokedAt
                  ? "Disconnected"
                  : connection.expired
                    ? "Expired · connect again from your AI client"
                    : connection.lastUsedAt
                      ? "Connected · authenticated access verified"
                      : "Approved · waiting for client verification"}
              </span>
            </div>
            {!connection.revokedAt && (
              <button
                type="button"
                className="connection-secondary"
                onClick={(event) => {
                  disconnectTrigger.current = event.currentTarget;
                  setDisconnecting(connection);
                }}
              >
                Disconnect {connection.clientName}
              </button>
            )}
          </article>
        ))}
      </section>
      <AlertDialog.Root
        open={!!disconnecting}
        onOpenChange={(open) => {
          if (!open && !busy) setDisconnecting(undefined);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="connection-dialog-overlay" />
          <AlertDialog.Content
            className="panel connection-confirm"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (disconnectTrigger.current?.isConnected
                ? disconnectTrigger.current
                : connectionsHeading.current
              )?.focus();
            }}
          >
            <AlertDialog.Title>Disconnect {disconnecting?.clientName}?</AlertDialog.Title>
            <AlertDialog.Description>
              This stops its access to {disconnecting?.workspaceName}, including existing tokens.
              Your reports and recordings stay in Scry. Other connections are unchanged.
            </AlertDialog.Description>
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy}>
                Keep connected
              </button>
            </AlertDialog.Cancel>
            <button type="button" onClick={() => void disconnect()} disabled={busy}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <details
        className="connection-advanced"
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary>Advanced: manual access-token setup</summary>
        {advanced && <AdvancedIntegrations />}
      </details>
    </>
  );
}
