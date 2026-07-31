import type { Provider } from "@supabase/supabase-js";
import {
  ArrowRight,
  Check,
  Eye,
  Github,
  MailCheck,
  Menu,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationMessage,
} from "../supabase.js";

type AuthMode = "signin" | "signup";

export function Landing() {
  const [authMode, setAuthMode] = useState<AuthMode>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setMobileOpen(false);
  };

  return (
    <div className="landing-shell">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />
      <header className="landing-nav">
        <a className="landing-brand" href="/" aria-label="Scry home">
          <span><Eye size={22} /></span>
          <strong>Scry</strong>
        </a>
        <nav className={mobileOpen ? "landing-links mobile-open" : "landing-links"}>
          <button className="nav-section-link" onClick={() => scrollToSection("product")}>Product</button>
          <button className="nav-section-link" onClick={() => scrollToSection("workflow")}>How it works</button>
          <button className="nav-section-link" onClick={() => scrollToSection("security")}>Security</button>
          <button className="nav-signin" onClick={() => setAuthMode("signin")}>Sign in</button>
          <button className="nav-start" onClick={() => setAuthMode("signup")}>
            Start testing <ArrowRight size={14} />
          </button>
        </nav>
        <button
          className="mobile-menu"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label="Toggle navigation"
        >
          {mobileOpen ? <X /> : <Menu />}
        </button>
      </header>

      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <div className="announcement"><Sparkles size={14} /> Deterministic browser testing for AI teams</div>
            <h1>Your product changed.<br /><em>Know what broke.</em></h1>
            <p>
              Turn plain-language requirements into controlled browser runs, immutable evidence,
              and reports your team—and your coding agent—can act on.
            </p>
            <div className="hero-actions">
              <button className="landing-primary" onClick={() => setAuthMode("signup")}>
                Create your workspace <ArrowRight size={17} />
              </button>
            </div>
            <div className="hero-proof">
              <span><Check size={13} /> No credit card</span>
              <span><Check size={13} /> Local-first runner</span>
              <span><Check size={13} /> Auditable by design</span>
            </div>
          </div>

          <div className="product-visual" aria-label="Scry run report preview">
            <div className="visual-top">
              <div><i /><i /><i /></div>
              <span>RUN / VITRACT-ACCEPTANCE</span>
              <strong>LIVE</strong>
            </div>
            <div className="visual-body">
              <aside>
                <div className="mini-logo"><Eye size={16} /></div>
                <span className="active" /><span /><span /><span /><span />
              </aside>
              <div className="visual-content">
                <div className="visual-kicker">EXECUTION REPORT</div>
                <div className="visual-heading">
                  <div><h3>Signup & onboarding</h3><p>Chrome · 1280 × 720 · 24.2s</p></div>
                  <b>PASSED</b>
                </div>
                <div className="visual-metrics">
                  <div><small>ASSERTIONS</small><strong>12/12</strong></div>
                  <div><small>ARTIFACTS</small><strong>19</strong></div>
                  <div><small>POLICY</small><strong>ENFORCED</strong></div>
                </div>
                <div className="visual-timeline">
                  {["Open application", "Authenticate test account", "Complete onboarding", "Verify final state"].map((step, index) => (
                    <div key={step}>
                      <span><Check size={11} /></span>
                      <div><strong>{step}</strong><small>{index === 3 ? "3 assertions passed" : "Completed successfully"}</small></div>
                      <code>{index === 0 ? "navigate" : index === 1 ? "fill" : "assert"}</code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="trust-strip">
          <span>BUILT FOR TEAMS SHIPPING WITH</span>
          <div><strong>Playwright</strong><strong>Codex</strong><strong>GitHub</strong><strong>Postgres</strong><strong>Chrome</strong></div>
        </section>

        <section className="landing-features" id="product">
          <div className="section-heading">
            <span>THE TESTING CONTROL PLANE</span>
            <h2>From requirement to evidence,<br />without the mystery.</h2>
          </div>
          <div className="feature-grid">
            <article><div><Zap size={20} /></div><span>01</span><h3>Controlled execution</h3><p>Every click, fill, navigation, and assertion follows a validated, constrained plan.</p></article>
            <article><div><Eye size={20} /></div><span>02</span><h3>Evidence that lasts</h3><p>Screenshots, DOM, network events, diagnostics, and traces stay attached to every run.</p></article>
            <article><div><ShieldCheck size={20} /></div><span>03</span><h3>Secure by default</h3><p>Origin allowlists, secret references, action budgets, and immutable execution context.</p></article>
          </div>
        </section>

        <section className="workflow-section" id="workflow">
          <div><span>01</span><strong>Describe the journey</strong><p>Give Scry the requirement, related destinations, and expected outcome.</p></div>
          <ArrowRight />
          <div><span>02</span><strong>Run in real Chrome</strong><p>A constrained Playwright worker executes and records the plan.</p></div>
          <ArrowRight />
          <div><span>03</span><strong>Fix with confidence</strong><p>Humans and coding agents read the same durable report.</p></div>
        </section>

        <section className="landing-cta" id="security">
          <div className="cta-orbit"><Eye size={30} /><span /><span /></div>
          <span>YOUR NEXT RELEASE DESERVES EVIDENCE</span>
          <h2>Stop wondering.<br />Start knowing.</h2>
          <button className="landing-primary" onClick={() => setAuthMode("signup")}>
            Build your first test <ArrowRight size={17} />
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-brand"><span><Eye size={19} /></span><strong>Scry</strong></div>
        <p>Controlled browser intelligence for teams that ship.</p>
        <small>© {new Date().getFullYear()} Scry</small>
      </footer>

      {authMode && <AuthDialog mode={authMode} onMode={setAuthMode} onClose={() => setAuthMode(undefined)} />}
    </div>
  );
}

function AuthDialog({
  mode,
  onMode,
  onClose,
}: {
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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

  const oauth = async (provider: Provider) => {
    if (!supabase) return setError(supabaseConfigurationMessage);
    setError("");
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) setError(oauthError.message);
  };

  return (
    <div className="auth-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-dialog" role="dialog" aria-modal="true" aria-label={mode === "signin" ? "Sign in to Scry" : "Create a Scry account"}>
        <button className="auth-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <div className="auth-brand"><span><Eye size={21} /></span><strong>Scry</strong></div>
        {verificationEmail ? (
          <div className="verification-state">
            <div className="verification-icon"><MailCheck size={30} /></div>
            <span>VERIFY YOUR EMAIL</span>
            <h2>Check your inbox</h2>
            <p>
              We sent a verification link to <strong>{verificationEmail}</strong>.
              Open the email and confirm your address to activate your Scry workspace.
            </p>
            <div className="verification-help">
              Didn’t receive it? Check your spam folder or resend the email.
            </div>
            {error && <div className="auth-message error">{error}</div>}
            {notice && <div className="auth-message success">{notice}</div>}
            <button className="auth-submit" disabled={resending} onClick={() => void resendVerification()}>
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
          <h2>{mode === "signin" ? "Sign in to your workspace" : "Create your Scry workspace"}</h2>
          <p>{mode === "signin" ? "Your runs, reports, and evidence are waiting." : "Get a controlled browser testing workspace in minutes."}</p>
        </div>
        <div className="oauth-grid">
          <button onClick={() => void oauth("google")}><GoogleMark /> Continue with Google</button>
          <button onClick={() => void oauth("github")}><Github size={17} /> Continue with GitHub</button>
        </div>
        <div className="auth-divider"><span>OR CONTINUE WITH EMAIL</span></div>
        <form onSubmit={(event) => void authenticate(event)}>
          <label><span>Work email</span><input required type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label><span>Password</span><input required minLength={8} type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} placeholder="At least 8 characters" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <div className="auth-message error">{error}</div>}
          {notice && <div className="auth-message success">{notice}</div>}
          {!isSupabaseConfigured && <div className="auth-message config">Authentication UI is ready. Add your Supabase project variables to connect it.</div>}
          <button className="auth-submit" disabled={loading}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"} <ArrowRight size={16} />
          </button>
        </form>
        <p className="auth-switch">
          {mode === "signin" ? "New to Scry?" : "Already have an account?"}{" "}
          <button onClick={() => onMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
        <small className="auth-terms">By continuing, you agree to Scry’s Terms and Privacy Policy.</small>
          </>
        )}
      </section>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.5 14.1a6 6 0 0 1 0-4.2V7.3H3.2a10 10 0 0 0 0 9.4l3.3-2.6Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.9.5 4 1.5l2.7-2.7A9 9 0 0 0 12 2a10 10 0 0 0-8.8 5.3l3.3 2.6a5.8 5.8 0 0 1 5.5-4Z" />
    </svg>
  );
}
