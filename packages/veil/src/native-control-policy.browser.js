const nativeControlLimits = Object.freeze({
  boundValues: 256,
  boundBytes: 16 * 1024 * 1024,
  learnedValues: 128,
  learnedBytes: 65536,
  learnedLength: 4096,
  controls: 500,
  labels: 16,
  semanticLength: 8192,
});
// Shared literal policy source. Values and bound-reference authority are not
// inputs: this classifies current control facts for privacy only.
function nativeSemanticWords(value) {
  return String(value ?? "")
    .slice(0, nativeControlLimits.semanticLength)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase();
}
function nativePublicMetadata(value) {
  const words = nativeSemanticWords(value).trim();
  if (
    /\b(?:password|passphrase|token|secret|api key|private key|credentials?|(?:credit |debit )?card(?: number)?|account number|routing number|iban|cvv|cvc)\s+(?:name|label|title|status|count|setting|enabled|policy|protection|strength|requirements?)\b/u.test(
      words,
    ) ||
    /\b(?:password|passphrase|token|secret|api key|private key|credentials?|(?:credit |debit )?card(?: number)?|account number|routing number|iban|cvv|cvc)\s+(?:display|friendly)\s+(?:name|label|title)(?:\s+read only)?$/u.test(
      words,
    )
  )
    return true;
  // Metadata must be the subject, with an explicit relationship to the
  // credential object. A payload "access token for the account display name"
  // cannot become metadata merely because display/name words occur later.
  const relationship =
    /^(?:(?:the|your|public|read only)\s+)?(?:(?:display|friendly)\s+)?(?:name|label|title|status|count|setting|policy|protection|strength|requirements?)\s+(?:for|of|about)\s+(.+)$/u.exec(
      words,
    );
  if (!relationship) return false;
  const object = relationship[1];
  const subject =
    /\b(?:password|passphrase|token|secret|api key|private key|credentials?|(?:credit |debit )?card(?: number)?|account number|routing number|iban|cvv|cvc)(?:\s+read only)?$/u.exec(
      object,
    );
  // A complete qualified noun phrase, not a trailing payload instruction.
  return (
    subject !== null &&
    object
      .slice(0, subject.index)
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .every((word) =>
        /^(?:a|an|the|your|this|that|private|public|service|access|authentication|auth|api|client|current|new|old|saved|pad|account|session|refresh|csrf|deletion|delete|removal|revocation|recovery|backup|one|time|verification|activation|signing|encryption|credit|debit|bank)$/u.test(
          word,
        ),
      )
  );
}
function nativeSemanticClass(value) {
  const words = nativeSemanticWords(value),
    legacy = words.replace(/[^a-z]/g, "");
  if (nativePublicMetadata(words)) return "metadata";
  if (
    /^(?:(?:your|generated|current|new) )?(?:secret|private (?:key|token|credential))(?: value| read only)?$/u.test(
      words.trim(),
    )
  )
    return "private_payload";
  if (
    /password|passwd|passphrase|authtoken|accesstoken|sessioncookie|apikey|clientsecret|recoverycode|backupcode|onetimecode|cardnumber|ccnumber|cccsc|ccexp|creditcard|accountnumber|routingnumber|iban|cvv|cvc/u.test(
      legacy,
    ) ||
    /\b(?:password|passwd|passphrase|cvv|cvc|iban)\b/u.test(words) ||
    /\b(?:auth|authentication|access|refresh|csrf|session|client|api|signing|encryption)\s+(?:token|secret|key|cookie)\b/u.test(
      words,
    ) ||
    /\b(?:deletion|delete|removal|revocation|revoke)\s+(?:token|key|secret|code)\b/u.test(words) ||
    /\b(?:recovery|backup|one time|verification|activation)\s+(?:code|token|key|password)\b/u.test(
      words,
    ) ||
    /\b(?:card|credit card|debit card|bank account|account|routing)\s+(?:number|security code|expiry|expiration)\b/u.test(
      words,
    ) ||
    /\b(?:authtoken|accesstoken|refreshtoken|csrftoken|sessioncookie|apikey|clientsecret|deletiontoken|deletetoken|recoverycode|backupcode|onetimecode|cardnumber|ccnumber|cccsc|ccexp|creditcard|accountnumber|routingnumber)\b/u.test(
      words,
    )
  )
    return "private_payload";
  if (
    /\b(?:service(?:\s+access)?|access|authentication|auth|api|client|recovery|backup)\s+credentials?\b/u.test(
      words,
    )
  )
    return "credential";
  return "unknown";
}
function nativeSensitiveSemantic(value) {
  const category = nativeSemanticClass(value);
  return category === "private_payload" || category === "credential";
}
function nativePayloadControl(type, role) {
  const kind = type == null ? null : String(type).toLowerCase(),
    semanticRole = String(role ?? "").toLowerCase();
  if (kind === "password") return true;
  if (/^(?:checkbox|radio|switch|button|menuitemcheckbox|menuitemradio)$/.test(semanticRole))
    return false;
  // Snapshot fallback knows a role, never a fabricated DOM input type.
  if (kind === null) return semanticRole === "textbox" || semanticRole === "spinbutton";
  return /^(?:text|password|hidden|email|number|tel|url|search|textarea|date|datetime-local|month|week|time)$/.test(
    kind,
  );
}
function nativeClassifyControl(facts) {
  const payload = nativePayloadControl(facts.type, facts.role);
  const decision = (mask, learn, source, needsLabels = false) => ({
    mask,
    learn,
    source,
    needsLabels,
  });
  if (facts.explicit === true) return decision(true, payload, "explicit");
  if (!payload) return decision(false, false, "nonpayload");
  if (facts.type === "password" || nativeSemanticClass(facts.autocomplete) === "private_payload")
    return decision(true, true, "intrinsic");
  const identifiers = [facts.name, facts.id];
  if (identifiers.some((value) => nativeSemanticClass(value) === "private_payload"))
    return decision(true, true, "private_identifier");
  if (!Array.isArray(facts.labels)) return decision(false, false, "unknown", true);
  if (facts.labels.some(nativeSensitiveSemantic)) return decision(true, true, "private_label");
  if (facts.labels.some(nativePublicMetadata)) return decision(false, false, "metadata");
  if (identifiers.some((value) => nativeSemanticClass(value) === "credential"))
    return decision(true, true, "weak_identifier");
  return decision(false, false, "unknown");
}

// Prototype canonical native intrinsic definitions, shared by text and pixels.
const nativeStrongDefinitions = [
  [
    "private_key_material",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/dgu,
  ],
  ["bearer", /\bBearer\s+([A-Za-z0-9._~+\/=-]{12,})/dgu, 1],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/dgu],
  ["provider_token", /\b(?:sk_live_|sk_test_|ghp_)[A-Za-z0-9_-]{8,}/dgu],
  [
    "private_assignment",
    /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*([^\s,;"'&<>]{4,})/dgiu,
    1,
  ],
  [
    "secret_url_parameter",
    /\b(?:requesttoken|csrf[_-]?token|access[_-]?token|auth[_-]?token|sessionid|api[_-]?key)=([^&\s"'<>]+)/dgiu,
    1,
  ],
  [
    "credential_connection",
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s\/@:]+:([^\s\/@]+)@[^\s"'<>]+/dgiu,
    1,
  ],
  [
    "recovery_assignment",
    /\b(?:recovery|backup)[\s_-]*code\s*[:=]\s*([A-Z0-9][A-Z0-9-]{3,31})\b/dgiu,
    1,
  ],
];
function nativeIntrinsicFindings(text) {
  const matches = [];
  for (const [family, pattern, payloadGroup = 0] of nativeStrongDefinitions) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices[payloadGroup];
      matches.push({ family, strength: "strong", start, end, value: match[payloadGroup] });
    }
  }
  // Emit disjoint ranges from the ORIGINAL scalar. Overlapping strong families
  // share authority; applying offsets repeatedly after replacement corrupts public suffixes.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const disjoint = [];
  for (const found of matches) {
    const previous = disjoint[disjoint.length - 1];
    if (previous && found.start < previous.end) {
      previous.end = Math.max(previous.end, found.end);
      previous.value = text.slice(previous.start, previous.end);
    } else disjoint.push({ ...found });
  }
  return disjoint;
}
// Bounded fallback naming evidence. Never a binding, credential or input capability.
function nativeAdjacentFieldLabel(facts) {
  if (
    facts.hasCanonicalName ||
    facts.ownMetadata ||
    facts.labelHidden ||
    !facts.sameParent ||
    !facts.pureTextLabel ||
    !facts.atomicTarget ||
    facts.editable ||
    facts.interactiveTarget
  )
    return undefined;
  if (
    !/^(?:p|span|div|dt|label)$/.test(facts.labelTag) ||
    facts.labelHasFor ||
    facts.labelInteractive ||
    facts.labelHasExplicitName
  )
    return undefined;
  if (facts.control && (!facts.readonly || !nativePayloadControl(facts.type, facts.role)))
    return undefined;
  if (!facts.control && !facts.presentation) return undefined;
  const value = String(facts.value ?? "");
  // The field relation cannot absorb a following prose block or descendant group.
  if (!value || value.length > nativeControlLimits.learnedLength || /\s/u.test(value))
    return undefined;
  const label = String(facts.label ?? "");
  if (label.length > nativeControlLimits.semanticLength) return undefined;
  const words = nativeSemanticWords(label).trim();
  if (nativePublicMetadata(words) || !nativeSensitiveSemantic(words)) return undefined;
  const noun =
    /\b(?:password|passwd|passphrase|secret|token|key|cookie|credentials?|code|account number|routing number|card number|card security code|card expiry|card expiration|iban|cvv|cvc)$/u.exec(
      words,
    );
  if (!noun) return undefined;
  const prefix = words.slice(0, noun.index).trim().split(/\s+/u).filter(Boolean);
  if (
    !prefix.every((word) =>
      /^(?:your|the|this|current|new|saved|generated|private|service|access|authentication|auth|api|client|session|refresh|csrf|signing|encryption|deletion|delete|removal|revocation|recovery|backup|one|time|verification|activation|credit|debit|bank)$/u.test(
        word,
      ),
    )
  )
    return undefined;
  return label;
}

function nativePresentationDecision(facts) {
  if (facts.explicit) return { private: true, source: "explicit" };
  if (facts.labels.some(nativeSensitiveSemantic)) return { private: true, source: "private_label" };
  if (facts.labels.some(nativePublicMetadata)) return { private: false, source: "metadata" };
  return { private: false, source: "ordinary_or_unknown" };
}

const nativeAXRoleFamilies = Object.freeze([
  "code",
  "paragraph",
  "generic",
  "text",
  "img",
  "status",
  "button",
  "option",
  "heading",
  "link",
  "textbox",
  "spinbutton",
  "unconfirmed",
]);
