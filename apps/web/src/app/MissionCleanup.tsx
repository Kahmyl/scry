import { useEffect, useState } from "react";
import { api, post } from "../infrastructure/api/client.js";

type Item = {
  id: string;
  kind: "resource" | "credential";
  label: string;
  ownership: string;
  state: string;
  cleanupStatus: string;
  decision?: string;
  reason?: string;
  expiresAt?: string;
  allowedDecisions: string[];
};
type Ledger = { complete: boolean; items: Item[]; note: string };
export function MissionCleanup({
  missionId,
  readOnly = false,
}: {
  missionId: string;
  readOnly?: boolean;
}) {
  return <CleanupPanel key={missionId} missionId={missionId} readOnly={readOnly} />;
}
function CleanupPanel({ missionId, readOnly }: { missionId: string; readOnly: boolean }) {
  const [ledger, setLedger] = useState<Ledger>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Item>(),
    [decision, setDecision] = useState("retain"),
    [reason, setReason] = useState("testing_finished"),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [attemptKey, setAttemptKey] = useState("");
  useEffect(() => {
    let active = true;
    void api<Ledger>(`/missions/${missionId}/cleanup`)
      .then((d) => {
        if (!d || !Array.isArray(d.items) || typeof d.complete !== "boolean")
          throw Error("invalid_cleanup_response");
        if (active) {
          setLedger(d);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Cleanup facts could not be loaded. Refresh to retry.");
      });
    return () => {
      active = false;
    };
  }, [missionId, reload]);
  async function save() {
    if (!selected || !confirmed) return;
    setBusy(true);
    try {
      const r = await post<Ledger>(`/missions/${missionId}/cleanup`, {
        kind: selected.kind,
        itemId: selected.id,
        decision,
        reason,
        confirmed: true,
        idempotencyKey: attemptKey,
      });
      setLedger(r);
      setSelected(undefined);
      setError("");
    } catch {
      setError("Cleanup could not be confirmed. Refresh the ledger before retrying the same item.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Cleanup and retained resources">
      <h3>Cleanup and retained resources</h3>
      <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
        Refresh cleanup
      </button>
      {error && <p role="alert">{error}</p>}
      {ledger && (
        <>
          <p>
            {ledger.complete
              ? "All listed items have ended or have a recorded retention decision."
              : "Some resources still need cleanup or a retention decision."}
          </p>
          <p>{ledger.note}</p>
          <ul>
            {ledger.items.map((item) => (
              <li key={item.kind + item.id}>
                <strong>{item.label}</strong> — {item.state};{" "}
                {item.cleanupStatus.replaceAll("_", " ")}
                {item.reason ? `; ${item.reason.replaceAll("_", " ")}` : ""}
                {item.expiresAt ? ` · Expires ${new Date(item.expiresAt).toLocaleString()}` : ""}
                {!readOnly && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setSelected(item);
                      setAttemptKey(crypto.randomUUID());
                      setDecision("retain");
                      setReason(
                        item.ownership === "shared_preexisting"
                          ? "shared_preexisting"
                          : "testing_finished",
                      );
                      setConfirmed(false);
                    }}
                  >
                    Review {item.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!ledger.items.length && <p>No cleanup resources are recorded for this Mission.</p>}
        </>
      )}
      {selected && !readOnly && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h4>{selected.label}</h4>
          <p>
            Recorded observations remain. Closing a customer mailbox only disconnects Scry; shared
            credentials are retained.
          </p>
          <label>
            Action
            <select
              value={decision}
              onChange={(e) => {
                setDecision(e.target.value);
                setAttemptKey(crypto.randomUUID());
                setConfirmed(false);
              }}
            >
              {selected.allowedDecisions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setAttemptKey(crypto.randomUUID());
                setConfirmed(false);
              }}
            >
              {[
                "testing_finished",
                "user_selected_retention",
                "shared_preexisting",
                "needed_for_recovery",
              ].map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I confirm this decision for {selected.label}.
          </label>
          <button disabled={busy || !confirmed}>Save cleanup decision</button>
          <button type="button" disabled={busy} onClick={() => setSelected(undefined)}>
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}
