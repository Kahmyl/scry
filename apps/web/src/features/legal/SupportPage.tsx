import { BrandMark } from "../../shared/components/BrandMark.js";
import { privacyContact } from "./policies.js";
import "./legal-page.css";

export function SupportPage() {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <div className="legal-header-inner">
          <a className="legal-brand" href="/" aria-label="Scry home">
            <BrandMark size={32} />
            <strong>Scry</strong>
          </a>
        </div>
      </header>
      <main className="legal-container">
        <div className="legal-introduction">
          <h1>Contact support</h1>
          <p>Need help connecting your assistant, running a test or finding a report?</p>
        </div>
        <article className="legal-content">
          <section>
            <h2>How we can help</h2>
            <p>
              Tell us what you were trying to do and what happened. Include the report or Mission
              link if it helps us identify the problem.
            </p>
            <p>
              Do not send passwords, access tokens, payment-card details or private recordings by
              email.
            </p>
            <a href={`mailto:${privacyContact}`}>Email Scry support</a>
          </section>
          <section>
            <h2>Manage your connections</h2>
            <p>
              Sign in to Scry to see which AI clients have access to your workspace and disconnect
              any you no longer use.
            </p>
            <a href="/dashboard/integrations">Open connections</a>
          </section>
        </article>
      </main>
    </div>
  );
}
