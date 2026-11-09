import {
  CheckCircle2,
  Check,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  MousePointer2,
  Download,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { api, remove } from "../../infrastructure/api/client.js";
import { publicConfig } from "../../infrastructure/config/runtime-config.js";
import { PageTitle } from "../../shared/components/dashboard-primitives.js";
import { createSetupCommand } from "../../../scripts/desktop-bootstrap.mjs";
import type { createSetupCommand as SetupCommandFactory } from "../../../scripts/desktop-bootstrap.d.mts";
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
type Client = "codex" | "claude" | "cursor" | "other";

const hostedEndpoint = "https://scry.giize.com/mcp";
declare const __SCRY_DESKTOP_INSTALLER_SHA__: string;
const setupCommand: ReturnType<typeof SetupCommandFactory> = createSetupCommand(
  __SCRY_DESKTOP_INSTALLER_SHA__,
);
const desktopSetupPrompt = `Install Scry using the tested installer below. Run this one command; it checks the installer checksum, validates the package, preserves existing connections and opens my browser for Scry sign-in. On Windows run it in PowerShell; on macOS or Linux use the normal shell. Do not write another installer or repeat manual package checks. Tell me that the browser will open and let me sign in and choose my workspace myself. Never approve consent for me. Stop on conflicts or unsupported hosts. If authorization needs attention, show the returned URL as a clickable link using its linkLabel and explain the next click in plain language; do not send me looking for an unspecified host control. Never log into an existing bare-name MCP server. Only after the installer reports authorization.status=authorized, verify workspace access with read-only list_projects through the installed plugin's scry_beta connection, never an older scry connection. If that plugin tool is not available in this chat after successful authorization, say workspace access is not yet checked. Never claim a working sign-in when setup reports needs_attention. Describe the result without tool names or technical jargon. Do not claim access from installation alone. Do not start tests.\n\n${setupCommand}`;

export function Connections() {
  const [client, setClient] = useState<Client>("codex");
  const [state, setState] = useState<Connections>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [disconnecting, setDisconnecting] = useState<Connection>();
  const [checkMessage, setCheckMessage] = useState("");
  const disconnectTrigger = useRef<HTMLButtonElement | null>(null);
  const connectionsHeading = useRef<HTMLHeadingElement | null>(null);
  const endpoint = new URL(publicConfig.mcpServerUrl, window.location.origin).href;
  const packageSetup = client === "codex" && endpoint === hostedEndpoint;
  const activeConnections = state?.connections.filter(
    (connection) => !connection.revokedAt && !connection.expired,
  );
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
      setError("");
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
      setState(
        (current) =>
          current && {
            ...current,
            connections: current.connections.filter(
              (connection) => connection.id !== disconnecting.id,
            ),
          },
      );
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
    <div className="connections-page">
      <PageTitle
        eyebrow="CONNECTIONS"
        title="Connect your AI assistant"
        copy="Start tests from your assistant. Keep the reports, recordings and results together in Scry."
      />
      <div className="connections-layout">
        <section className="connection-setup panel" aria-labelledby="connection-heading">
          <div className="connection-heading">
            <span className="connection-icon">
              <PlugZap size={24} />
            </span>
            <div>
              <h2 id="connection-heading">Add a connection</h2>
              <p>Choose your assistant to see how to connect.</p>
            </div>
          </div>
          <div className="connection-clients" role="radiogroup" aria-label="AI client setup guides">
            {(
              [
                ["codex", "ChatGPT / Codex", Code2],
                ["claude", "Claude", Sparkles],
                ["cursor", "Cursor", MousePointer2],
                ["other", "Other MCP clients", PlugZap],
              ] as const
            ).map(([value, label, Icon]) => (
              <label key={value} data-active={client === value}>
                <input
                  type="radio"
                  name="scry-client-guide"
                  value={value}
                  aria-label={label}
                  checked={client === value}
                  onChange={() => {
                    setClient(value);
                    setCopied(false);
                  }}
                />
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
                <Check className="connection-client-check" size={14} aria-hidden="true" />
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
              Guided sign-in is not enabled on this deployment yet. Existing connections still work.
            </p>
          )}
          {state?.available && (
            <>
              <ol className="connection-guide">
                <li>
                  <span>1</span>
                  <div>
                    {packageSetup ? (
                      <>
                        <h3>Install the Scry plugin</h3>
                        <p>Choose where you use your assistant. No connection address to copy.</p>
                        <div className="connection-install-options">
                          <section
                            className="connection-install-option"
                            aria-labelledby="web-setup-heading"
                          >
                            <h4 id="web-setup-heading">ChatGPT web</h4>
                            <p>
                              Download the package, then open ChatGPT’s Plugins page. Choose Add →
                              Upload plugin archive and select the ZIP.
                            </p>
                            <div className="connection-install-actions">
                              <a
                                className="connection-primary"
                                href="/plugins/scry-chatgpt.zip"
                                download
                              >
                                <Download size={15} /> Download Scry plugin
                              </a>
                              <a
                                href="https://chatgpt.com/plugins"
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open ChatGPT Plugins <ExternalLink size={14} />
                              </a>
                            </div>
                            <p className="connection-install-note">
                              Requires an account that allows plugin uploads and custom connections.
                              If upload or connection is unavailable, open Other methods below.
                            </p>
                          </section>
                          <section
                            className="connection-install-option"
                            aria-labelledby="desktop-setup-heading"
                          >
                            <h4 id="desktop-setup-heading">Desktop / Codex</h4>
                            <p>
                              Open a setup chat in the desktop app, then send the prepared message.
                              The tested installer handles the package checks and installation in
                              one command. Then connect your Scry account if prompted.
                            </p>
                            <a
                              className="connection-primary"
                              href={`codex://new?prompt=${encodeURIComponent(desktopSetupPrompt)}`}
                            >
                              Open desktop setup <ExternalLink size={15} />
                            </a>
                            <p className="connection-install-note">
                              Setup opens your browser so you can sign in and choose a workspace.
                              Requires the desktop app, Node.js 18+ and Codex CLI. This installs on
                              your computer; it does not also install in ChatGPT web or mobile.
                            </p>
                          </section>
                        </div>
                        <details className="connection-package">
                          <summary>Other methods</summary>
                          <p>
                            Add a custom remote MCP server in your assistant’s connection settings.
                            Name it Scry and use this address, then choose OAuth sign-in.
                          </p>
                          <div className="connection-endpoint">
                            <code className="connection-address">{endpoint}</code>
                            <button
                              type="button"
                              className="connection-primary"
                              onClick={() => void copy()}
                            >
                              <Copy size={15} /> {copied ? "Address copied" : "Copy Scry address"}
                            </button>
                          </div>
                          <p>
                            Already using Codex CLI? Ask it to install the{" "}
                            <a
                              href="/plugins/scry-desktop-setup.txt"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Scry desktop package
                            </a>
                            . You can also{" "}
                            <a href="/plugins/scry-codex.zip" download>
                              download the ZIP
                            </a>{" "}
                            for manual installation.
                          </p>
                        </details>
                      </>
                    ) : (
                      <>
                        {client === "codex" && (
                          <p className="connection-notice">
                            Plugin downloads connect to hosted Scry at scry.giize.com. To connect to
                            this server, use its address below.
                          </p>
                        )}
                        <h3>
                          Open{" "}
                          {client === "codex"
                            ? "Codex or ChatGPT"
                            : client === "claude"
                              ? "Claude"
                              : client === "cursor"
                                ? "Cursor"
                                : "your assistant"}
                          {client === "cursor" ? " and add Scry" : " settings"}
                        </h3>
                        <p>
                          {client === "codex"
                            ? "Add a custom remote MCP server in your assistant’s integration settings. Use this server address."
                            : client === "claude"
                              ? "Open Settings → Connectors → Add custom connector. Name it Scry and use this server address. Your team may need to enable custom connectors first."
                              : client === "cursor"
                                ? "Use Add to Cursor, then review the connection in Cursor."
                                : "Add a custom remote MCP connection in your assistant’s settings. Name it Scry, use this address and choose OAuth if supported."}
                        </p>
                        <div className="connection-endpoint">
                          <code className="connection-address">{endpoint}</code>
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
                        </div>
                        {client === "claude" && (
                          <details className="connection-code-option">
                            <summary>Using Claude Code?</summary>
                            <code className="connection-command">
                              claude mcp add --transport http scry {endpoint}
                            </code>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <h3>Sign in and choose a workspace</h3>
                    <p>
                      When your assistant opens Scry, sign in, choose your workspace and select
                      Allow connection.
                    </p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <h3>Check that you’re connected</h3>
                    <p>Ask your assistant:</p>
                    <blockquote className="connection-prompt">
                      Can you see my Scry projects?
                    </blockquote>
                    <p>
                      Once it can, describe what you want to test and share the application address.
                    </p>
                  </div>
                </li>
              </ol>
              <p className="connection-footnote">
                <ShieldCheck size={17} /> Sign in securely. No access token to copy. Keep passwords
                in Scry’s protected inputs, outside chat.
              </p>
              {(client === "claude" || client === "cursor") && (
                <details className="connection-package">
                  <summary>Optional workflow skills</summary>
                  {endpoint !== "https://scry.giize.com/mcp" && (
                    <p>
                      These downloads connect to hosted Scry at scry.giize.com, not this local or
                      custom server. Use the connection address above to test this server.
                    </p>
                  )}
                  <p>
                    These packages add setup, testing and report-review guidance where your client
                    supports plugins. They do not contain credentials or replace sign-in.
                  </p>
                  <a href={`/plugins/scry-${client}.zip`} download>
                    Download {client === "claude" ? "Claude" : "Cursor"} package
                  </a>
                  <p>
                    Install the downloaded package using your client’s local-plugin instructions.
                    These downloads are private packages, not public marketplace listings.
                  </p>
                </details>
              )}
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
            <div>
              <h2 id="connected-heading" ref={connectionsHeading} tabIndex={-1}>
                Your connections
              </h2>
              <p>Assistants with active access to your workspace.</p>
            </div>
            <button
              type="button"
              className="connection-refresh"
              aria-label="Refresh connection list"
              title="Refresh connection list"
              onClick={() => void load(true)}
              disabled={busy}
            >
              <RefreshCw size={17} className={busy ? "connection-spin" : ""} />
            </button>
          </div>
          {checkMessage && (
            <p role="status" className="connection-refresh-result">
              {checkMessage}
            </p>
          )}
          {activeConnections?.length === 0 && (
            <div className="panel connection-empty">
              <span className="connection-empty-icon">
                <PlugZap size={24} />
              </span>
              <h3>No active connections</h3>
              <p>
                Follow the setup steps, then refresh this list. Your assistant appears here after
                you approve access.
              </p>
            </div>
          )}
          {activeConnections?.map((connection) => (
            <article className="panel connection-row" key={connection.id}>
              <div>
                <h3>
                  <span className="connection-row-icon">
                    <PlugZap size={17} />
                  </span>
                  {connection.clientName}
                </h3>
                <p>{connection.workspaceName}</p>
                <span
                  className={`connection-status ${connection.lastUsedAt ? "connection-confirmed" : ""}`}
                >
                  {connection.lastUsedAt ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}
                  {connection.lastUsedAt
                    ? "Connected · authenticated access verified"
                    : "Approved · waiting for client verification"}
                </span>
              </div>
              <button
                type="button"
                className="connection-secondary"
                onClick={(event) => {
                  disconnectTrigger.current = event.currentTarget;
                  setDisconnecting(connection);
                }}
              >
                <span aria-hidden="true">Disconnect</span>
                <span className="connection-sr-only">Disconnect {connection.clientName}</span>
              </button>
            </article>
          ))}
          <p className="connection-access-note">
            <ShieldCheck size={17} />
            You control access. Disconnect an assistant at any time; your reports and recordings
            stay in Scry.
          </p>
        </section>
      </div>
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
    </div>
  );
}
