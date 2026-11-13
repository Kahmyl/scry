import { useState } from "react";
import { api } from "../../infrastructure/api/client.js";
const renewalLabels = new Map([
  ["renewed", "Account access renewed."],
  ["retry_recovered", "An interrupted renewal was recovered."],
  ["replay_refused", "An older renewal credential was reused; reconnect Scry in your assistant."],
  ["disconnected", "This connection was disconnected."],
]);
type Facts = {
  oauthDiscoveryConfigured: boolean;
  hostToolExposure: string;
  connection?: {
    revoked: boolean;
    workspaceAccess: boolean;
    grantAvailable: boolean;
    clientRegistrationAvailable: boolean;
    grantExpiresAt?: string;
    lastAuthenticatedUse?: string;
    lastRenewalEvent?: { outcome: string; at: string } | null;
  };
};

function ConnectionNextStep({ facts }: { facts: Facts }) {
  const connection = facts.connection;
  if (!facts.oauthDiscoveryConfigured)
    return (
      <p role="status">
        Scry's account connection service is not configured. You do not need to change your
        password. <a href="https://scry.giize.com/support">Contact Scry support</a> to restore the
        service.
      </p>
    );
  if (!connection)
    return (
      <p role="status">
        Scry could not establish this connection's access. Check again using the button above; if it
        still cannot be checked, contact Scry support. Your authorization was not changed.
      </p>
    );
  if (!connection.workspaceAccess)
    return (
      <p role="status">
        This connection no longer has access to the workspace. Ask the workspace owner to restore
        access before trying to connect again.
      </p>
    );
  if (connection.revoked || !connection.grantAvailable || !connection.clientRegistrationAvailable)
    return (
      <p role="status">
        This saved connection can no longer authorize testing. Connect Scry again through your
        assistant's normal connection flow, choose the intended workspace and ask the assistant to
        check access before resuming tests.
      </p>
    );
  return (
    <div>
      <p role="status">
        Your Scry permission is current. This page cannot tell which tools your assistant has
        loaded. Ask the assistant to check its Scry workspace access before resuming tests.
      </p>
      <details>
        <summary>Missing tools in your assistant?</summary>
        <p>
          Use the instructions for your connection type. Do not reconnect or reinstall while sign-in
          is working.
        </p>
        <details>
          <summary>Codex Desktop plugin</summary>
          <p>
            In Codex Settings → Plugins, turn the whole Scry plugin off and back on. This reloads
            the plugin; its server may not have a separate Refresh control. Return to your chat and
            ask the assistant to check access again. Individual skill switches do not reload the
            whole plugin.
          </p>
        </details>
        <details>
          <summary>Custom MCP connection</summary>
          <p>
            Use your assistant's supported restart or refresh control for the Scry server, if it
            offers one. Then ask the assistant to check access again. These are different controls
            from a packaged plugin's switch.
          </p>
        </details>
        <p>
          If your assistant has different controls, or one reload does not restore access, preserve
          the working sign-in and <a href="https://scry.giize.com/support">contact Scry support</a>{" "}
          with your assistant's name and the check result. Do not share passwords or connection
          tokens.
        </p>
      </details>
    </div>
  );
}
export function ConnectionDiagnostics({ connectionId }: { connectionId: string }) {
  return <Checks key={connectionId} id={connectionId} />;
}
function Checks({ id }: { id: string }) {
  const [facts, setFacts] = useState<Facts>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect() {
    setBusy(true);
    try {
      setFacts(await api<Facts>(`/integrations/connections/${id}/diagnostics`));
      setError("");
    } catch {
      setError("Connection checks could not be loaded. Your authorization was not changed.");
    } finally {
      setBusy(false);
    }
  }
  const c = facts?.connection;
  return (
    <div>
      <button disabled={busy} type="button" onClick={() => void inspect()}>
        Check connection details
      </button>
      {error && <p role="status">{error}</p>}
      {facts && (
        <div aria-label="Connection diagnostic facts">
          <ConnectionNextStep facts={facts} />
          <details>
            <summary>Technical connection details</summary>
            <p>
              {!facts.oauthDiscoveryConfigured
                ? "Account-linking discovery is not configured on this server."
                : "Server account-linking discovery is configured."}
            </p>
            {c && (
              <ul>
                <li>
                  {c.revoked
                    ? "Authorization revoked."
                    : "Authorization has not been revoked in Scry."}
                </li>
                <li>
                  {c.workspaceAccess
                    ? "Workspace membership exists."
                    : "Workspace access was removed."}
                </li>
                <li>
                  {c.grantAvailable
                    ? "Consent grant is current."
                    : "Consent grant is expired or unavailable."}
                </li>
                <li>
                  {c.clientRegistrationAvailable
                    ? "Client registration is present."
                    : "Client registration is expired or unavailable; refresh may fail."}
                </li>
                {c.grantExpiresAt && (
                  <li>Grant expires: {new Date(c.grantExpiresAt).toLocaleString()}</li>
                )}
                {c.lastAuthenticatedUse && (
                  <li>
                    Last authenticated request: {new Date(c.lastAuthenticatedUse).toLocaleString()}
                  </li>
                )}
                {c.lastRenewalEvent && (
                  <li>
                    {renewalLabels.get(c.lastRenewalEvent.outcome) ?? "Renewal status unavailable."}{" "}
                    {new Date(c.lastRenewalEvent.at).toLocaleString()}
                  </li>
                )}
              </ul>
            )}
            <p>
              These are Scry server facts. This page cannot verify which tools your assistant
              loaded. A valid grant with missing tools needs a host discovery check; installation
              alone does not prove access. No permissions were changed.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
