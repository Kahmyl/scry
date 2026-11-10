import { useState } from "react";
import { api, post } from "../infrastructure/api/client.js";

/** Recovery uses the same scoped, fenced API as agent tools. */
export function RunRecovery({ runId }: { runId: string }) {
  // Confirmation and asynchronous status belong to one exact attempt.
  return <AttemptRecovery key={runId} runId={runId} />;
}

function AttemptRecovery({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [conclusion, setConclusion] = useState(
    "Testing was stopped as incomplete. Preserve evidence and any uncertain application outcomes.",
  );
  const inspect = async () => {
    setBusy(true);
    try {
      const s = await api<{ terminal: boolean; browserReleased: boolean }>(`/runs/${runId}/status`);
      setMessage(
        s.browserReleased
          ? "Attempt ended. Browser release confirmed."
          : s.terminal
            ? "Attempt ended; browser release is not confirmed."
            : "Attempt is still active. You can finish it as incomplete.",
      );
    } catch {
      setMessage(
        "Attempt status could not be checked. Retry before assuming the browser was released.",
      );
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await post(`/runs/${runId}/stop`, { confirmed: true, conclusion });
      setOpen(false);
      await inspect();
    } catch {
      setMessage(
        "The attempt could not be confirmed ended. Check status; do not repeat application actions.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Attempt recovery">
      <button type="button" disabled={busy} onClick={() => void inspect()}>
        Check attempt and browser release
      </button>
      <button type="button" disabled={busy} onClick={() => setOpen(!open)}>
        Finish attempt as incomplete
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed && conclusion.trim()) void stop();
          }}
        >
          <p>
            This ends the selected attempt, preserves its evidence and records incomplete testing.
            It does not undo changes in the tested application.
          </p>
          <label>
            Reason
            <textarea
              value={conclusion}
              maxLength={4000}
              required
              onChange={(e) => setConclusion(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I want to end this attempt as incomplete.
          </label>
          <button disabled={busy || !confirmed || !conclusion.trim()}>
            End incomplete attempt
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
