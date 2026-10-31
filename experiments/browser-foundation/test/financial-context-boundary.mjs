// Adversarial follow-up: a card label elsewhere must not mask a product EAN.
// This is a finite text-policy experiment, not activated pixel/text policy.
import { mkdir, writeFile } from "node:fs/promises";
import { SensitiveValueClassifier } from "/workspace/packages/veil/src/classifier.ts";
const classifier = new SensitiveValueClassifier();
const pan = "4242424242424242",
  ean = "4000001000005";
const corpus = [
  { text: `Card number: ${pan}\nProduct EAN: ${ean}`, expected: [pan] },
  { text: `Product EAN: ${ean}\nCard number: ${pan}`, expected: [pan] },
  { text: `Use card view for Product EAN: ${ean}`, expected: [] },
  { text: `Card number:\n${pan}`, expected: [pan] },
  { text: `Card number:\nProduct EAN: ${ean}`, expected: [] },
  { text: `Payment card: ${pan}; Product EAN: ${ean}`, expected: [pan] },
];
const rows = corpus.map((c) => {
  const possible = classifier.findings(c.text).filter((f) => f.category === "payment-card");
  const values = (fs) => fs.map((f) => c.text.slice(f.start, f.start + f.length));
  const broad = values(
    possible.filter(() =>
      /\b(?:card|payment|credit|debit|visa|mastercard|amex|pan)\b/i.test(c.text),
    ),
  );
  const bounded = values(
    possible.filter((f) =>
      /\b(?:(?:payment|credit|debit)\s+)?(?:card(?:\s*(?:number|no\.?))?|pan|visa|mastercard|amex)\s*[:=]\s*$/i.test(
        c.text.slice(Math.max(0, f.start - 80), f.start),
      ),
    ),
  );
  return {
    ...c,
    broad,
    bounded,
    broadPassed: JSON.stringify(broad) === JSON.stringify(c.expected),
    boundedPassed: JSON.stringify(bounded) === JSON.stringify(c.expected),
  };
});
const root = "/results/financial-context-boundary-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
await writeFile(root + "/results.json", JSON.stringify({ root, rows }, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    root,
    cases: rows.length,
    broadPasses: rows.filter((r) => r.broadPassed).length,
    boundedPasses: rows.filter((r) => r.boundedPassed).length,
  }),
);
if (rows.some((r) => !r.boundedPassed)) process.exitCode = 1;
