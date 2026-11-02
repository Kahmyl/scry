import { ArrowRight, MailCheck, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { BrandMark } from "../../shared/components/BrandMark.js";
import { LandingPage } from "./LandingPage.js";
import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationMessage,
} from "../../infrastructure/auth/supabase.js";

type AuthMode = "signin" | "signup";

/** Presentation delegates account actions to the existing authentication lifecycle. */
export function Landing({
  authError = "",
  initialSignIn = false,
}: {
  authError?: string;
  initialSignIn?: boolean;
}) {
  const [authMode, setAuthMode] = useState<AuthMode | undefined>(
    authError || initialSignIn ? "signin" : undefined,
  );
  useEffect(() => {
    if (authError) setAuthMode("signin");
  }, [authError]);
  return (
    <>
      <LandingPage onSignIn={() => setAuthMode("signin")} onSignUp={() => setAuthMode("signup")} />
      {authMode && (
        <AuthDialog
          mode={authMode}
          onMode={setAuthMode}
          onClose={() => setAuthMode(undefined)}
          initialError={authError}
        />
      )}
    </>
  );
}

function AuthDialog({
  mode,
  onMode,
  onClose,
  initialError,
}: {
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  onClose: () => void;
  initialError: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [resending, setResending] = useState(false);

  const authenticate = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return setError(supabaseConfigurationMessage);
    setLoading(true);
    setError("");
    setNotice("");
    const result =
      mode === "signup"
        ? await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin },
          })
        : await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (result.error) return setError(result.error.message);
    if (mode === "signup" && !result.data.session) {
      setVerificationEmail(email);
    }
  };

  const resendVerification = async () => {
    if (!supabase || !verificationEmail) return;
    setResending(true);
    setError("");
    setNotice("");
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email: verificationEmail,
      options: { emailRedirectTo: window.location.origin },
    });
    setResending(false);
    if (resendError) {
      setError(resendError.message);
      return;
    }
    setNotice("A new verification email has been sent.");
  };

  const oauth = async () => {
    if (!supabase) return setError(supabaseConfigurationMessage);
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (oauthError)
        setError("Google sign-in is unavailable. Please try again or sign in with email.");
    } catch {
      setError("We couldn’t connect to Google sign-in. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="auth-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "signin" ? "Sign in to Scry" : "Create a Scry account"}
      >
        <button className="auth-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="auth-brand">
          <span>
            <BrandMark />
          </span>
          <strong>Scry</strong>
        </div>
        {verificationEmail ? (
          <div className="verification-state">
            <div className="verification-icon">
              <MailCheck size={30} />
            </div>
            <span>VERIFY YOUR EMAIL</span>
            <h2>Check your inbox</h2>
            <p>
              We sent a verification link to <strong>{verificationEmail}</strong>. Open the email
              and confirm your address to activate your Scry workspace.
            </p>
            <div className="verification-help">
              Didn’t receive it? Check your spam folder or resend the email.
            </div>
            {error && <div className="auth-message error">{error}</div>}
            {notice && <div className="auth-message success">{notice}</div>}
            <button
              className="auth-submit"
              disabled={resending}
              onClick={() => void resendVerification()}
            >
              {resending ? "Sending…" : "Resend verification email"}
            </button>
            <button
              className="verification-back"
              onClick={() => {
                setVerificationEmail("");
                setNotice("");
                setError("");
                onMode("signin");
              }}
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <div className="auth-heading">
              <span>{mode === "signin" ? "WELCOME BACK" : "START TESTING"}</span>
              <h2>
                {mode === "signin" ? "Sign in to your workspace" : "Create your Scry workspace"}
              </h2>
              <p>
                {mode === "signin"
                  ? "Your runs, reports, and evidence are waiting."
                  : "Get a controlled browser testing workspace in minutes."}
              </p>
            </div>
            <div className="oauth-grid">
              <button disabled={loading} onClick={() => void oauth()}>
                <GoogleMark /> Continue with Google
              </button>
            </div>
            <div className="auth-divider">
              <span>OR CONTINUE WITH EMAIL</span>
            </div>
            <form onSubmit={(event) => void authenticate(event)}>
              <label>
                <span>Work email</span>
                <input
                  required
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  required
                  minLength={8}
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error && (
                <div className="auth-message error" role="alert">
                  {error}
                </div>
              )}
              {notice && <div className="auth-message success">{notice}</div>}
              {!isSupabaseConfigured && (
                <div className="auth-message config">
                  Authentication UI is ready. Add your Supabase project variables to connect it.
                </div>
              )}
              <button className="auth-submit" disabled={loading}>
                {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}{" "}
                <ArrowRight size={16} />
              </button>
            </form>
            <p className="auth-switch">
              {mode === "signin" ? "New to Scry?" : "Already have an account?"}{" "}
              <button onClick={() => onMode(mode === "signin" ? "signup" : "signin")}>
                {mode === "signin" ? "Create an account" : "Sign in"}
              </button>
            </p>
            <small className="auth-terms">
              By continuing, you agree to Scry’s{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer">
                Terms of Service
              </a>{" "}
              and acknowledge the{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
              .
            </small>
          </>
        )}
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22Z"
      />
      <path fill="#FBBC05" d="M6.5 14.1a6 6 0 0 1 0-4.2V7.3H3.2a10 10 0 0 0 0 9.4l3.3-2.6Z" />
      <path
        fill="#EA4335"
        d="M12 5.9c1.5 0 2.9.5 4 1.5l2.7-2.7A9 9 0 0 0 12 2a10 10 0 0 0-8.8 5.3l3.3 2.6a5.8 5.8 0 0 1 5.5-4Z"
      />
    </svg>
  );
}
