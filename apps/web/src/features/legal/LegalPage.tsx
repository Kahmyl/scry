import { ArrowLeft, ArrowUpRight, FileText, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { BrandMark } from "../../shared/components/BrandMark.js";
import {
  type PolicyDocument,
  policyEffectiveDate,
  privacyContact,
  privacyPolicy,
  termsOfService,
} from "./policies.js";
import "./legal-page.css";

export function LegalPage({ policy }: { policy: PolicyDocument }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${policy.title} · Scry`;
    return () => {
      document.title = previous;
    };
  }, [policy.title]);

  const Icon = policy.path === "/privacy" ? ShieldCheck : FileText;
  return (
    <div className="legal-page">
      <a className="legal-skip-link" href="#policy-content">
        Skip to policy
      </a>
      <header className="legal-header">
        <div className="legal-header-inner">
          <a className="legal-brand" href="/" aria-label="Scry home">
            <BrandMark size={32} />
            <strong>Scry</strong>
          </a>
          <a className="legal-back" href="/">
            <ArrowLeft size={15} aria-hidden="true" /> Back to Scry
          </a>
        </div>
      </header>

      <main className="legal-container" id="policy-content" tabIndex={-1}>
        <div className="legal-introduction">
          <span className="legal-kicker">
            <Icon size={16} aria-hidden="true" /> THE DETAILS THAT MATTER
          </span>
          <h1>{policy.title}</h1>
          <p>{policy.summary}</p>
          <div className="legal-meta">
            <span>Effective {policyEffectiveDate}</span>
            <span>Operated by Kamil</span>
          </div>
        </div>

        <nav className="legal-documents" aria-label="Legal documents">
          {[privacyPolicy, termsOfService].map((document) => (
            <a
              key={document.path}
              href={document.path}
              aria-current={policy.path === document.path ? "page" : undefined}
            >
              {document.title}
            </a>
          ))}
        </nav>

        <div className="legal-layout">
          <aside className="legal-sidebar" aria-label="Policy navigation">
            <nav aria-label="On this page">
              <h2>On this page</h2>
              {policy.sections.map((section) => (
                <a href={`#${section.id}`} key={section.id}>
                  {section.title}
                </a>
              ))}
            </nav>
          </aside>

          <article className="legal-content" aria-label={policy.title}>
            {policy.sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
                <h2 id={`${section.id}-heading`}>{section.title}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
            <div className="legal-contact">
              <h2>Let’s help you with that.</h2>
              <p>Questions about this policy or your information? Contact Kamil.</p>
              <a href={`mailto:${privacyContact}`}>
                {privacyContact} <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
          </article>
        </div>
      </main>
      <footer className="legal-footer">
        <span>© {new Date().getFullYear()} Scry</span>
        <a href={`mailto:${privacyContact}`}>{privacyContact}</a>
      </footer>
    </div>
  );
}
