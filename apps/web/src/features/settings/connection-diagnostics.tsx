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
            These are Scry server facts. This page cannot verify which tools your assistant loaded.
            A valid grant with missing tools needs a host discovery check; installation alone does
            not prove access. No permissions were changed.
          </p>
        </div>
      )}
    </div>
  );
}
