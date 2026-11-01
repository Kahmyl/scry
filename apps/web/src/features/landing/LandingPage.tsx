import {
  ArrowRight,
  Camera,
  Check,
  CircleAlert,
  Eye,
  FileText,
  Globe2,
  ListChecks,
  LockKeyhole,
  Menu,
  MousePointer2,
  Play,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./landing-page.css";
import { BrandMark } from "../../shared/components/BrandMark.js";

const reportSteps = [
  {
    title: "Account created",
    detail: "Form submitted and account page reached",
  },
  {
    title: "Welcome page displayed",
    detail: "Expected heading found in Chromium",
  },
  {
    title: "Profile persisted",
    detail: "Profile available after reopening",
  },
  {
    title: "Welcome message wraps",
    detail: "375 px viewport · confirm intended layout",
    observation: true,
  },
];

export function LandingPage({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileOpen(false);
      window.requestAnimationFrame(() => mobileToggle.current?.focus());
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  const closeNavigation = () => setMobileOpen(false);
  const openAuth = (mode: "signin" | "signup") => {
    setMobileOpen(false);
    if (mode === "signin") onSignIn();
    else onSignUp();
  };

  return (
    <div className="landing-page" id="top">
      <header className="lp-header">
        <div className="lp-header-inner">
          <a className="lp-brand" href="#top" aria-label="Scry home" onClick={closeNavigation}>
            <BrandMark />
            <strong>Scry</strong>
          </a>

          <nav
            id="lp-navigation"
            className={mobileOpen ? "lp-nav is-open" : "lp-nav"}
            aria-label="Main navigation"
          >
            <div className="lp-nav-sections">
              <a href="#product" onClick={closeNavigation}>
                Product
              </a>
              <a href="#workflow" onClick={closeNavigation}>
                How it works
              </a>
              <a href="#security" onClick={closeNavigation}>
                Security
              </a>
            </div>
            <div className="lp-nav-account">
              <button className="lp-signin" type="button" onClick={() => openAuth("signin")}>
                Sign in
              </button>
              <button className="lp-nav-cta" type="button" onClick={() => openAuth("signup")}>
                Start testing <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </nav>

          <button
            ref={mobileToggle}
            className="lp-menu-button"
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="lp-navigation"
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? (
              <X size={21} aria-hidden="true" />
            ) : (
              <Menu size={21} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      <main>
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <div className="lp-container">
            <div className="lp-hero-copy">
              <div className="lp-announcement">
                <Sparkles size={14} aria-hidden="true" />
                Browser testing with evidence, built for AI teams
              </div>
              <h1 id="lp-hero-title">
                <span>Your product changed.</span>
                <span>Know what broke.</span>
              </h1>
              <p>
                Describe what should work. Scry runs the journey in Chromium, captures what
                happened, and gives your team and coding agent one report to review.
              </p>
              <div className="lp-hero-actions">
                <button className="lp-button lp-button-primary" type="button" onClick={onSignUp}>
                  Create your workspace
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
                <a className="lp-button lp-button-secondary" href="#workflow">
                  See how it works
                  <ArrowRight size={16} aria-hidden="true" />
                </a>
              </div>
              <ul className="lp-hero-proof" aria-label="Getting started details">
                <li>
                  <Check size={13} aria-hidden="true" /> No credit card
                </li>
                <li>
                  <Check size={13} aria-hidden="true" /> Local-first runner
                </li>
                <li>
                  <Check size={13} aria-hidden="true" /> Reviewable evidence
                </li>
              </ul>
            </div>

            <figure className="lp-report" aria-labelledby="lp-report-title">
              <div className="lp-windowbar">
                <div className="lp-window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="lp-run-id">
                  <span aria-hidden="true" /> RUN-024
                </span>
                <strong>EXAMPLE DATA</strong>
              </div>

              <div className="lp-report-grid">
                <div className="lp-report-main">
                  <div className="lp-report-heading">
                    <div>
                      <p className="lp-report-kicker">APPLICATION TEST REPORT</p>
                      <h2 id="lp-report-title">Signup &amp; onboarding</h2>
                      <p className="lp-report-meta">Chromium · 1280 × 720 · 24.2s</p>
                    </div>
                    <span className="lp-reviewed">
                      <Check size={12} aria-hidden="true" /> Reviewed
                    </span>
                  </div>

                  <dl className="lp-report-summary">
                    <div>
                      <dt>Checks reviewed</dt>
                      <dd>3</dd>
                    </div>
                    <div>
                      <dt>Observations</dt>
                      <dd>1</dd>
                    </div>
                    <div>
                      <dt>Browser</dt>
                      <dd>Chromium</dd>
                    </div>
                  </dl>

                  <ol className="lp-run-steps">
                    {reportSteps.map((step) => (
                      <li
                        className={step.observation ? "is-observation" : undefined}
                        key={step.title}
                      >
                        <span className="lp-step-state" aria-hidden="true">
                          {step.observation ? <CircleAlert size={13} /> : <Check size={13} />}
                        </span>
                        <div>
                          <strong>{step.title}</strong>
                          <small>{step.detail}</small>
                        </div>
                        <code>{step.observation ? "OBSERVATION" : "CHECKED"}</code>
                      </li>
                    ))}
                  </ol>
                </div>

                <aside className="lp-evidence" aria-label="Example observation evidence">
                  <div className="lp-evidence-topline">
                    <span>OBSERVATION 01</span>
                    <strong>NEEDS REVIEW</strong>
                  </div>
                  <h3>Narrow-screen layout</h3>
                  <p>
                    The welcome message wraps at 375 px. Confirm whether this is the intended
                    layout.
                  </p>

                  <div className="lp-sample-browser">
                    <div className="lp-sample-address">
                      <span aria-hidden="true">•••</span>
                      <span>app.example.test/welcome</span>
                      <span>375 px</span>
                    </div>
                    <div className="lp-sample-page">
                      <div className="lp-sample-appbar">
                        <strong>northstar</strong>
                        <span>MS</span>
                      </div>
                      <div className="lp-sample-welcome">
                        <small>YOUR WORKSPACE</small>
                        <h4>Welcome, Maya.</h4>
                        <p>
                          Your workspace is ready. Invite your team and start building together.
                          <span aria-hidden="true">01</span>
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="lp-evidence-caption">
                    <Camera size={13} aria-hidden="true" />
                    Screenshot 04 · 375 px viewport
                  </div>
                  <div className="lp-evidence-files">
                    <span>
                      <FileText size={12} aria-hidden="true" /> DOM snapshot
                    </span>
                    <span>
                      <Play size={12} aria-hidden="true" /> Recording
                    </span>
                  </div>
                </aside>
              </div>

              <figcaption>
                <span>Example report · fictional data</span>
                <span>Observations require human review</span>
              </figcaption>
            </figure>

            <ul className="lp-capabilities" aria-label="Product capabilities">
              <li>
                <MousePointer2 size={16} aria-hidden="true" /> Real Chromium interaction
              </li>
              <li>
                <Camera size={16} aria-hidden="true" /> Screenshots &amp; recordings
              </li>
              <li>
                <ListChecks size={16} aria-hidden="true" /> Controlled Playwright runs
              </li>
              <li>
                <FileText size={16} aria-hidden="true" /> Reports built for review
              </li>
            </ul>
          </div>
        </section>

        <section className="lp-section lp-product" id="product">
          <div className="lp-container">
            <div className="lp-section-heading">
              <div>
                <p className="lp-eyebrow">THE TESTING CONTROL PLANE</p>
                <h2>A result you can inspect, not just believe.</h2>
              </div>
              <p>
                Scry keeps the plan, browser activity, and expected outcomes together, so a reviewer
                can understand the run without reconstructing it.
              </p>
            </div>

            <div className="lp-feature-list">
              <article className="lp-feature">
                <div className="lp-feature-topline">
                  <span>01</span>
                  <MousePointer2 size={21} aria-hidden="true" />
                </div>
                <h3>Controlled execution</h3>
                <p>
                  Turn a requirement into a constrained Playwright plan, then interact with a real
                  Chromium browser.
                </p>
              </article>
              <article className="lp-feature">
                <div className="lp-feature-topline">
                  <span>02</span>
                  <ScanSearch size={21} aria-hidden="true" />
                </div>
                <h3>Evidence in context</h3>
                <p>
                  Keep screenshots, recordings, DOM snapshots, network events, and traces attached
                  to the run they explain.
                </p>
              </article>
              <article className="lp-feature">
                <div className="lp-feature-topline">
                  <span>03</span>
                  <Eye size={21} aria-hidden="true" />
                </div>
                <h3>Observations, not verdicts</h3>
                <p>
                  Review expected outcomes and flagged observations in one report. Your team decides
                  what needs fixing.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="lp-workflow" id="workflow">
          <div className="lp-container lp-workflow-grid">
            <div className="lp-workflow-intro">
              <p className="lp-eyebrow">HOW IT WORKS</p>
              <h2>From a sentence to a shared source of truth.</h2>
              <p className="lp-workflow-lede">
                Start with the behavior you care about. Finish with a run your team and coding agent
                can inspect together.
              </p>
              <div className="lp-requirement">
                <span>EXAMPLE REQUIREMENT</span>
                <blockquote>
                  “A new user can create an account, see the welcome page, and find their profile
                  after reopening.”
                </blockquote>
                <p>
                  <FileText size={13} aria-hidden="true" /> Plain-language input
                </p>
              </div>
            </div>

            <ol className="lp-workflow-steps">
              <li>
                <span className="lp-workflow-number">01</span>
                <div>
                  <small>DESCRIBE</small>
                  <h3>Set out the journey</h3>
                  <p>
                    Add the requirement, relevant destinations, and the outcomes you expect to see.
                  </p>
                </div>
              </li>
              <li>
                <span className="lp-workflow-number">02</span>
                <div>
                  <small>RUN</small>
                  <h3>Execute in Chromium</h3>
                  <p>
                    A constrained Playwright worker follows the plan and records browser activity as
                    it goes.
                  </p>
                </div>
              </li>
              <li>
                <span className="lp-workflow-number">03</span>
                <div>
                  <small>REVIEW</small>
                  <h3>Decide what happens next</h3>
                  <p>
                    Inspect the evidence, discuss the observations, and hand the same report to your
                    coding agent.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section className="lp-controls" id="security">
          <div className="lp-container lp-controls-grid">
            <div>
              <p className="lp-eyebrow">SECURITY &amp; RUN CONTROLS</p>
              <h2>Guardrails you can explain.</h2>
              <p className="lp-controls-lede">
                Control where a run can go and what it can do. Scry is a testing tool, not a
                security perimeter: secret and financial-data masking is limited and best-effort, so
                review access and evidence before sharing.
              </p>
              <ul className="lp-control-list">
                <li>
                  <Globe2 size={19} aria-hidden="true" />
                  <div>
                    <strong>Origin allowlists</strong>
                    <span>Keep browser runs on approved destinations.</span>
                  </div>
                </li>
                <li>
                  <ShieldCheck size={19} aria-hidden="true" />
                  <div>
                    <strong>Action budgets</strong>
                    <span>Bound the actions available to an execution plan.</span>
                  </div>
                </li>
                <li>
                  <LockKeyhole size={19} aria-hidden="true" />
                  <div>
                    <strong>Secret references</strong>
                    <span>Use credentials without raw values in the requirement.</span>
                  </div>
                </li>
              </ul>
            </div>

            <div className="lp-manifest" aria-label="Example run policy">
              <div className="lp-manifest-header">
                <span>RUN POLICY / EXAMPLE</span>
                <strong>ILLUSTRATIVE</strong>
              </div>
              <dl>
                <div>
                  <dt>Allowed origin</dt>
                  <dd>app.example.test</dd>
                </div>
                <div>
                  <dt>Browser</dt>
                  <dd>Chromium</dd>
                </div>
                <div>
                  <dt>Action budget</dt>
                  <dd>40 maximum</dd>
                </div>
                <div>
                  <dt>Credentials</dt>
                  <dd>Referenced</dd>
                </div>
                <div>
                  <dt>Masking</dt>
                  <dd>Best effort</dd>
                </div>
              </dl>
              <p>
                <CircleAlert size={14} aria-hidden="true" /> Illustrative settings, not a live
                policy.
              </p>
            </div>
          </div>
        </section>

        <section className="lp-closing" aria-labelledby="lp-closing-title">
          <div className="lp-container">
            <p className="lp-eyebrow">YOUR NEXT RELEASE DESERVES EVIDENCE</p>
            <h2 id="lp-closing-title">
              Ship the change.
              <span>Keep the evidence.</span>
            </h2>
            <button className="lp-button lp-button-primary" type="button" onClick={onSignUp}>
              Build your first test <ArrowRight size={17} aria-hidden="true" />
            </button>
            <p className="lp-closing-note">
              One requirement. One controlled run. One report to review.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-brand" aria-label="Scry">
            <BrandMark size={31} />
            <strong>Scry</strong>
          </div>
          <p>Controlled browser testing for teams that ship.</p>
          <small>© {new Date().getFullYear()} Scry</small>
        </div>
      </footer>
    </div>
  );
}
