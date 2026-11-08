import type { Session } from "@supabase/supabase-js";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "../../shared/components/BrandMark.js";
import { supabase } from "../../infrastructure/auth/index.js";

function RecoveryPage({ children }: { children: ReactNode }) {
  return (
    <main className="auth-backdrop">
      <section className="auth-dialog" aria-label="Password recovery">
        <div className="auth-brand">
          <span>
            <BrandMark />
          </span>
          <strong>Scry</strong>
        </div>
        {children}
      </section>
    </main>
  );
}

export function PasswordResetRequest({ invalidLink = false }: { invalidLink?: boolean }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    if (!supabase || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) throw result.error;
      setSent(true);
      setEmail("");
    } catch {
      setError("We couldn’t send the reset email. Please wait a moment and try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <RecoveryPage>
      <div className="auth-heading">
        <h1>{sent ? "Check your inbox" : "Reset your password"}</h1>
        <p>
          {sent
            ? "If an account exists for that email, we’ll send a password reset link. Open the latest email to choose a new password."
            : "Enter your account email and we’ll send you a reset link."}
        </p>
      </div>
      {invalidLink && !sent && (
        <p role="alert" className="auth-message error">
          This reset link is invalid or has expired. Request a new link below.
        </p>
      )}
      {!sent && (
        <form onSubmit={(event) => void requestReset(event)}>
          <label>
            <span>Account email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="auth-message error">
              {error}
            </p>
          )}
          {!supabase && (
            <p role="alert">Password recovery is currently unavailable. Contact support.</p>
          )}
          <button className="auth-submit" disabled={busy || !supabase}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <p className="auth-switch">
        <Link to="/">Back to Scry</Link>
      </p>
    </RecoveryPage>
  );
}

export function PasswordRecovery({
  session,
  authError,
  onComplete,
}: {
  session: Session | null;
  authError: string;
  onComplete: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function updatePassword(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !session || authError || pending.current) return;
    setError("");
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirmation) return setError("The passwords don’t match.");
    pending.current = true;
    setBusy(true);
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ password });
      if (!active.current) return;
      if (updateError) {
        if (
          [
            "session_not_found",
            "session_expired",
            "refresh_token_not_found",
            "refresh_token_already_used",
          ].includes(updateError.code ?? "")
        ) {
          setExpired(true);
          setPassword("");
          setConfirmation("");
        } else {
          setError(
            updateError.code === "same_password"
              ? "Choose a password different from your previous password."
              : updateError.code === "weak_password"
                ? "Choose a stronger password. Try a longer password with a mix of characters."
                : "We couldn’t update your password. Please try again.",
          );
        }
        return;
      }
      if (data.user?.id !== session.user.id) throw new Error("Password update was not confirmed");
      setPassword("");
      setConfirmation("");
      setDone(true);
    } catch {
      if (active.current) setError("We couldn’t update your password. Please try again.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  if (!session || authError || expired) return <PasswordResetRequest invalidLink />;
  return (
    <RecoveryPage>
      <div className="auth-heading">
        <h1>{done ? "Password updated" : "Set a new password"}</h1>
        <p>
          {done
            ? "Your new password is ready to use the next time you sign in."
            : `Choose a new password for ${session.user.email ?? "your account"}.`}
        </p>
      </div>
      {done ? (
        <button className="auth-submit" onClick={onComplete}>
          Continue to workspace
        </button>
      ) : (
        <form onSubmit={(event) => void updatePassword(event)}>
          <label>
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="auth-message error">
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={busy}>
            {busy ? "Updating…" : "Update password"}
          </button>
        </form>
      )}
    </RecoveryPage>
  );
}
