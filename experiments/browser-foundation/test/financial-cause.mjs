// Small policy experiment, not activation or a replacement privacy platform.
import { mkdir, writeFile } from "node:fs/promises";
import { SensitiveValueClassifier } from "/workspace/packages/veil/src/classifier.ts";
const classifier = new SensitiveValueClassifier({
  protectedValues: { selected: "fictional-selected-secret-only" },
});
const luhn = (s) => {
  const d = s.replace(/\D/g, "");
  let n = 0;
  for (let i = d.length - 1, j = 0; i >= 0; i--, j++) {
    let v = Number(d[i]);
    if (j % 2) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    n += v;
  }
  return n % 10 === 0;
};
const ean = (base) => {
  let n = 0;
  for (let i = 0; i < 12; i++) n += Number(base[i]) * (i % 2 ? 3 : 1);
  return base + ((10 - (n % 10)) % 10);
};
const products = [];
for (let n = 400000100000; n < 400000101000 && products.length < 10; n++) {
  const value = ean(String(n));
  if (luhn(value)) products.push(value);
}
const corpus = [
  ...products.map((value) => ({ text: "Product EAN: " + value, expectedFinancial: false })),
  { text: "Card number: 4242 4242 4242 4242", expectedFinancial: true },
  { text: "Payment card: 378282246310005", expectedFinancial: true },
  { text: "Account number: 12345678", expectedFinancial: true },
  { text: "Routing number: 123456789", expectedFinancial: true },
  { text: "CVV: 123", expectedFinancial: true },
  { text: "Order reference: 12345678", expectedFinancial: false },
  { text: "Phone: 08012345678", expectedFinancial: false },
  { text: "Business note: fictional release", expectedFinancial: false },
  {
    text: "Unlabelled number 4242424242424242",
    expectedFinancial: false,
    limitation: "Intentional best-effort miss without semantic financial context",
  },
  { text: "fictional-selected-secret-only", expectedFinancial: false, expectedSecret: true },
  {
    text: "Authorization: Bearer fictional_access_token_123456",
    expectedFinancial: false,
    expectedSecret: true,
  },
];
// Reuse current exact/access-secret recognition. Change only the financial
// confidence rule, and add explicit obvious account/CVV context missing in text.
function proposed(text) {
  const existing = classifier.findings(text);
  const findings = existing.filter(
    (f) =>
      f.category !== "payment-card" ||
      /\b(?:card|payment|credit|debit|visa|mastercard|amex|pan)\b/i.test(text),
  );
  for (const m of text.matchAll(
    /\b(?:account|routing)(?:[\s_-]*number)?\s*[:=]\s*([\d -]{6,40})|\b(?:cvv|cvc)\s*[:=]\s*(\d{3,4})\b/gi,
  )) {
    const value = m[1] ?? m[2];
    findings.push({
      category: "financial-context",
      start: m.index + m[0].lastIndexOf(value),
      length: value.length,
    });
  }
  return findings;
}
const rows = corpus.map((c) => {
  const current = classifier.findings(c.text);
  const candidate = proposed(c.text);
  const financial = (xs) =>
    xs.some((f) => f.category === "payment-card" || f.category === "financial-context");
  return {
    ...c,
    currentFinancial: financial(current),
    candidateFinancial: financial(candidate),
    accessPreserved:
      !c.expectedSecret ||
      candidate.some((f) => f.category !== "payment-card" && f.category !== "financial-context"),
    candidatePassed:
      financial(candidate) === c.expectedFinancial && (!c.expectedSecret || candidate.length > 0),
  };
});
const root = "/results/financial-cause-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    root,
    rows,
    total: rows.length,
    passed: rows.filter((r) => r.candidatePassed).length,
  }),
);
if (rows.some((r) => !r.candidatePassed)) process.exitCode = 1;
