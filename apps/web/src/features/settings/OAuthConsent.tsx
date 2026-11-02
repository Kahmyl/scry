import { ArrowLeft, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, post } from "../../infrastructure/api/client.js";
import { CustomSelect } from "../../shared/components/CustomSelect.js";
import { BrandMark } from "../../shared/components/BrandMark.js";
import "./connections.css";

type RequestDetails = {
  clientName: string;
  callbackOrigin: string;
  permissions: string[];
  workspaces: { id: string; name: string; role: string }[];
};
export function OAuthConsent() {
  const { uid } = useParams();
  const [details, setDetails] = useState<RequestDetails>();
  const [workspace, setWorkspace] = useState("__choose");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setDetails(undefined);
    setWorkspace("__choose");
    setError("");
    if (!uid || !/^[A-Za-z0-9_-]{10,128}$/u.test(uid)) {
      setError("Start this connection from your AI client.");
      return;
    }
    void api<RequestDetails>(`/integrations/authorize/${uid}/details`)
      .then((value) => {
        if (active) setDetails(value);
      })
      .catch(() => {
        if (active)
          setError(
            "This connection could not be loaded. It may have expired. Return to your AI client and start again.",
          );
      });
    return () => {
      active = false;
    };
  }, [uid]);
  const decide = async (decision: "approve" | "deny") => {
    if (!uid || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ redirectTo: string }>(
        `/integrations/authorize/${uid}/decision`,
        decision === "deny" ? { decision } : { decision, workspaceId: workspace },
      );
      const target = new URL(result.redirectTo, window.location.origin);
      if (target.origin !== window.location.origin || !target.pathname.startsWith("/oauth/"))
        throw new Error("invalid_redirect");
      window.location.assign(target.href);
    } catch {
      setError(
        "Your decision could not be completed. No connection has been verified. Try again, or restart from your AI client.",
      );
      setBusy(false);
    }
  };
  return (
    <main className="connection-consent">
      <Link to="/dashboard/integrations" className="connection-back">
        <ArrowLeft size={15} />
        Back to Scry
      </Link>
      <section className="panel connection-consent-card">
        <BrandMark />
        <span className="connection-icon">
          <ShieldCheck size={26} />
        </span>
        <h1>Connect {details?.clientName ?? "your AI assistant"}</h1>
        <p className="connection-consent-intro">
          Choose what this connection can access. You can disconnect it at any time in Scry.
        </p>
        {!details && !error && (
          <p role="status" className="connection-status">
            <LoaderCircle size={20} className="connection-spin" />
            Loading the access request…
          </p>
        )}
        {details && (
          <>
            <div className="connection-client-notice">
              <strong>{details.clientName}</strong>
              <p>
                This name is supplied by the requesting client. Continue only if you started this
                connection.
              </p>
              <small>Returns to: {details.callbackOrigin}</small>
            </div>
            <CustomSelect
              label="Workspace to connect"
              value={workspace}
              onChange={setWorkspace}
              options={[
                { value: "__choose", label: "Choose a workspace", disabled: true },
                ...details.workspaces.map((item) => ({
                  value: item.id,
                  label: `${item.name}${item.role === "viewer" ? " · read-only membership" : ""}`,
                })),
              ]}
              disabled={busy}
            />
            <ul className="connection-permissions">
              {details.permissions.map((permission) => (
                <li key={permission}>
                  <ShieldCheck size={17} />
                  {permission}
                </li>
              ))}
            </ul>
            <p className="connection-footnote">
              This does not give permission to manage your account or other workspaces. The
              connection lasts up to 30 days and can be disconnected sooner. Your assistant still
              needs approval for consequential actions.
            </p>
            <div className="connection-consent-actions">
              <button
                type="button"
                className="connection-secondary"
                onClick={() => void decide("deny")}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="connection-primary"
                disabled={workspace === "__choose" || busy}
                onClick={() => void decide("approve")}
              >
                {busy ? (
                  <>
                    <LoaderCircle size={16} className="connection-spin" />
                    Returning to your client…
                  </>
                ) : (
                  "Allow connection"
                )}
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
