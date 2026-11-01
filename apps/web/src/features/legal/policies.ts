export const privacyContact = "kamilhabib556@gmail.com";
export const policyEffectiveDate = "1 November 2026";

export type PolicyDocument = {
  path: "/privacy" | "/terms";
  title: string;
  summary: string;
  sections: readonly { id: string; title: string; paragraphs: readonly string[] }[];
};

export const privacyPolicy: PolicyDocument = {
  path: "/privacy",
  title: "Privacy Policy",
  summary: "What Scry processes, why we need it, and the choices available to you.",
  sections: [
    {
      id: "who-we-are",
      title: "Who we are",
      paragraphs: [
        "Scry is a testing platform operated by Kamil. It currently supports browser-based testing and evidence review. For privacy questions or requests, use the contact address on this page.",
      ],
    },
    {
      id: "account-information",
      title: "Your account and sign-in",
      paragraphs: [
        "We process your email address, account identifiers, workspace membership and authentication information to create and secure your account.",
        "Scry uses Supabase for authentication. If you choose Sign in with Google, Google provides basic identity information to Supabase, which may include your name, email address, profile picture and Google account identifier. Scry’s application records use the authenticated identity identifier and email address to associate you with your Scry workspace.",
        "Google sign-in requests only OpenID, email and basic profile permissions. It does not give Scry access to your Gmail messages, Google Drive files, calendar, contacts or browsing history. Your Google password is entered with Google, not collected by Scry.",
      ],
    },
    {
      id: "testing-content",
      title: "Testing content and evidence",
      paragraphs: [
        "We process the information you and your connected agents provide or generate while using Scry. This includes project and environment details, testing instructions, mission objectives, browser actions, application observations, reports, screenshots and recordings. Content displayed by an application you test may therefore become part of your evidence.",
        "If you supply test credentials or other protected values, Scry processes them to carry out the actions you request. Use dedicated test accounts and fictional test data wherever possible. Do not submit information you are not authorized to disclose or process.",
      ],
    },
    {
      id: "service-operation",
      title: "Service operation and support",
      paragraphs: [
        "We process technical records needed to operate and troubleshoot the service, such as request and error records, timestamps, service activity and available connection information. We also process messages you send for support.",
        "Authentication uses browser storage and may involve cookies used by Google or Supabase. These mechanisms support sign-in and session continuity.",
      ],
    },
    {
      id: "information-use",
      title: "How we use information",
      paragraphs: [
        "We use information to authenticate users, manage workspace access, carry out requested tests, store and display evidence, provide support, investigate problems and protect the service against unauthorized use.",
        "Google account information is used for account identification, sign-in and related account security, not for unrelated profiling. We do not sell Google account information, use it for advertising or use it to train general-purpose AI models.",
      ],
    },
    {
      id: "information-sharing",
      title: "Who can receive information",
      paragraphs: [
        "Information is processed by the service providers needed to run Scry, including Supabase for authentication and our cloud hosting and storage providers. Google processes information when you choose Google sign-in under its own privacy policy.",
        "Your authorized workspace users and connected agents or tools may receive testing information and evidence within their permitted access. When you connect an external AI agent or export evidence, the receiving service’s own terms and privacy practices also apply. Google sign-in does not itself grant an agent access to your workspace.",
        "The operator may access information when necessary to provide requested support, investigate service or security problems, or meet legal obligations. We may disclose information when legally required or necessary to protect users, the service or others from unlawful activity.",
        "Service providers may process information in countries different from your own. We do not promise a particular country of storage or data residency arrangement.",
      ],
    },
    {
      id: "evidence-protection",
      title: "Evidence protection and its limits",
      paragraphs: [
        "Scry uses access controls and encryption for saved protected values. Automatic visual redaction targets recognizable access secrets and financial details using localized black masks. It does not automatically conceal all personal, business or sensitive content.",
        "Automatic redaction is best effort. Sensitive information may remain. Review evidence before sharing. Do not treat masking as a substitute for controlling what data is present in the tested application. No system can guarantee complete security or complete redaction.",
      ],
    },
    {
      id: "retention-and-choices",
      title: "Retention and your choices",
      paragraphs: [
        "We retain account information, testing records and evidence while needed to provide the service, respond to requests and meet applicable legal or security obligations. Retention depends on the type of information, whether the account or workspace remains in use and whether deletion has been requested. There is no fixed automatic evidence-expiry period promised by this policy.",
        "Contact us at the address on this page to request access, correction, account closure or deletion. We may need to verify your identity and your authority over a workspace before acting. Your request may affect shared workspace records; another person’s independent records are not automatically deleted.",
        "You can remove Scry’s Google connection through your Google Account settings. Removing that connection is separate from requesting deletion of information already stored in Scry. Backup copies and records required for legal or security reasons may need separate handling. Contact us for information about a particular record or deletion request.",
      ],
    },
    {
      id: "updates",
      title: "Updates and contact",
      paragraphs: [
        "We will keep this policy accessible from Scry’s public website. Material changes will be communicated through the service or an appropriate contact channel. If we seek to use Google data for a new purpose requiring consent, we will explain that purpose and obtain the necessary consent before doing so.",
      ],
    },
  ],
};

export const termsOfService: PolicyDocument = {
  path: "/terms",
  title: "Terms of Service",
  summary: "The terms for using Scry’s hosted browser-testing service.",
  sections: [
    {
      id: "about-scry",
      title: "About Scry",
      paragraphs: [
        "Scry is operated by Kamil. It provides tools for testing applications and reviewing evidence. The current service supports browser-based testing.",
        "These terms govern use of Scry’s hosted service. By creating an account or using the service, you agree to these terms. For questions, use the contact address on this page.",
      ],
    },
    {
      id: "account-and-authority",
      title: "Your account and authority",
      paragraphs: [
        "Keep your account, agent tokens and test credentials secure. Only connect agents and tools you trust. If you act for an organization, you must have authority to use Scry and provide its information on that organization’s behalf.",
        "Use only applications, environments and accounts you own or have permission to test. You are responsible for setting appropriate testing scope and for authorizing consequential actions. Do not use Scry to access another person’s systems or data without permission, bypass access controls, carry out unlawful activity, or disrupt a service.",
        "Use dedicated test accounts, least-privilege credentials and fictional test data wherever possible. Testing can change application state. An instruction to an agent is not a guarantee that every requested action is safe or reversible.",
      ],
    },
    {
      id: "content-and-services",
      title: "Your content and connected services",
      paragraphs: [
        "You retain your rights in the instructions, application information and other content you provide. You give Scry permission to process, store and display that content as needed to provide the requested service, subject to the Privacy Policy.",
        "Only provide content you have the right to use and share. You control which people, agents and external tools you connect or authorize. Those services have their own terms, availability limits and privacy practices.",
        "Google is an optional sign-in provider; using Google sign-in does not grant Scry permission to read Gmail, Drive or other unrelated Google services.",
      ],
    },
    {
      id: "results-and-evidence",
      title: "Test results, reports and evidence",
      paragraphs: [
        "Scry helps you carry out tests and inspect what happened. A report covers only the scenarios, actions and conditions actually examined. An observation is not necessarily a defect, and an incomplete test does not establish that an application is faulty. You remain responsible for evaluating findings and deciding whether changes are needed.",
        "Evidence does not certify that an application is free of defects, secure, compliant with a standard or suitable for a particular purpose. Do not rely on Scry alone for decisions that require independent professional assessment.",
        "Automatic redaction is best effort. Sensitive information may remain in screenshots, recordings or other output. Review evidence before exporting or sharing it. Scry is not a guarantee of complete privacy protection or a certification service for handling financial information.",
      ],
    },
    {
      id: "beta-limitations",
      title: "Hosted beta limitations",
      paragraphs: [
        "The service is currently a beta. Features may change, work may be interrupted, and availability or evidence capture may be limited. These beta terms do not include an uptime service-level agreement, unlimited storage or a guarantee that every interaction can be completed.",
        "Keep independent copies of material you need. We may change or withdraw beta features and will communicate material changes where reasonably practicable. Any future paid offering must disclose its pricing and applicable terms before you agree to a charge; these terms do not authorize a purchase on your behalf.",
      ],
    },
    {
      id: "ending-use",
      title: "Service protection and ending use",
      paragraphs: [
        "You may stop using Scry at any time. Contact us at the address on this page to request account closure or deletion of associated information as described in the Privacy Policy.",
        "We may restrict access when necessary to address unauthorized use, material abuse, security risks or legal requirements. Where appropriate and permitted, we will explain the restriction and provide a way to contact us. Account closure does not automatically remove another user’s independently held data.",
      ],
    },
    {
      id: "responsibility",
      title: "Warranties, responsibility and mandatory rights",
      paragraphs: [
        "To the extent permitted by applicable law, the beta is provided as available, without a promise of uninterrupted operation, complete test coverage or error-free results. Nothing in these terms excludes a right or responsibility that cannot lawfully be excluded.",
      ],
    },
    {
      id: "changes-and-contact",
      title: "Changes and contact",
      paragraphs: [
        "Approved terms and material updates will be available on Scry’s public website. Where a change requires renewed agreement, users will be asked to agree before the changed terms apply to them.",
      ],
    },
  ],
};
