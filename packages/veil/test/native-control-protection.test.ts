import { expect, it } from "vitest";
import type { NativeBrowserProtectionPort } from "@scry/contracts";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";
import { nativeSensitiveSemantic } from "../src/native-control-policy.js";

const value = "fictional-generated-private-value";
const line = (label: string, secret = value) =>
  `- textbox ${JSON.stringify(label)} [active] [ref=e8]: ${secret}`;
// The provider snapshot and metadata channels have distinct authority.
function snapshot(policy: NativeBrowserProtectionPort, text: string): string {
  return policy.cleanTextContent([{ type: "text", text }], true)[0]!.text!;
}
function accept(policy: NativeBrowserProtectionPort, readId: number, facts: unknown) {
  return policy.acceptNativeRead(readId, facts, { pageId: 0, worldId: 0 });
}
function receipt(policy: NativeBrowserProtectionPort, readId: number, values: unknown[] = []) {
  return {
    version: 1,
    readId,
    policyGeneration: policy.policyGeneration,
    text: "complete" as const,
    image: { state: "available" as const, assessment: "best_effort_known_candidates" as const },
    knownRequirement: "absent_in_supported_snapshot" as const,
    values,
    coveredValues: values,
    coveredBoundIndices: [],
    textCandidateScope: { readId, policyGeneration: policy.policyGeneration },
    textCandidateRefs: [],
    imageCandidateRefs: [],
    count: {
      roots: 1,
      nodes: 1,
      textNodes: 0,
      controls: 1,
      presentations: 0,
      pseudoReads: 0,
      rectangles: 0,
    },
  };
}
it("preserves a public display name describing a private credential in snapshot and later text", () => {
  const policy = createNativeAdapterProtector({});
  const input = line("Display name for private access credential", "ordinary-public-name");
  expect(snapshot(policy, input)).toBe(input);
  expect(policy.clean("Later ordinary-public-name remains public")).toBe(
    "Later ordinary-public-name remains public",
  );
});
it.each([
  "  Display name for private access credential  ",
  "Private access credential display name",
  "Friendly label of the service access credential",
])("keeps relational metadata public in fallback text: %s", (label) => {
  const input = line(label, "ordinary-public-name");
  expect(snapshot(createNativeAdapterProtector({}), input)).toBe(input);
});
it("keeps an authoritative short bound value protected even in a metadata control", () => {
  const policy = createNativeAdapterProtector({ selected: "on" });
  expect(snapshot(policy, line("Display name for private access credential", "on"))).not.toBe(
    line("Display name for private access credential", "on"),
  );
});
it.each([
  "Your pad deletion token (read-only)",
  "Access token",
  "Recovery code",
  "Password",
  "API key",
  "Bank account number",
  "Client secret",
])("protects labelled snapshot values and later appearances: %s", (label) => {
  const policy = createNativeAdapterProtector({});
  const output = String(snapshot(policy, line(label)));
  expect(output).toContain(JSON.stringify(label));
  expect(output).not.toContain(value);
  expect(policy.clean(`Later returned ${value}`)).not.toContain(value);
  expect(policy.clean(Buffer.from(value).toString("base64"))).not.toContain(
    Buffer.from(value).toString("base64"),
  );
});
it.each(["Invoice number", "Issue number", "Token count", "Deletion status", "Record identifier"])(
  "preserves ordinary %s control output",
  (label) => {
    const input = line(label, "ordinary-customer-business-output");
    expect(snapshot(createNativeAdapterProtector({}), input)).toBe(input);
    expect(nativeSensitiveSemantic(label)).toBe(false);
  },
);
it("handles quoted and escaped names without rewriting controls or other snapshot facts", () => {
  const policy = createNativeAdapterProtector({});
  const input = line('Your "deletion token" (read-only)') + '\n- button "Continue" [ref=e9]';
  const output = String(snapshot(policy, input));
  expect(output).not.toContain(value);
  expect(output).toContain('button "Continue" [ref=e9]');
});
it("harvests control metadata values privately and retains them across a legitimate policy update", () => {
  const policy = createNativeAdapterProtector({});
  const read = policy.beginNativeRead();
  expect(accept(policy, read, receipt(policy, read, [value]))).toBe(true);
  expect(policy.finishNativeRead(read, true)).toBe(true);
  expect(policy.diagnosticDetailAllowed()).toBe(false);
  expect(policy.clean(value)).not.toContain(value);
  const stale = receipt(policy, read, ["stale-value"]);
  policy.updateSecrets({ newlySelected: "another-fictional-bound-value" });
  expect(accept(policy, read, stale)).toBe(false);
  const next = policy.beginNativeRead();
  accept(policy, next, receipt(policy, next, []));
  policy.finishNativeRead(next, true);
  expect(policy.clean(value)).not.toContain(value);
  expect(policy.readExpression).toContain(value); // Private CDP expression, never a tool result.
  policy.dispose();
  expect(policy.readExpression).not.toContain(value);
  expect(accept(policy, next, receipt(policy, next, [value]))).toBe(false);
  expect(policy.clean(value)).not.toContain(value);
});
it("withholds text when a read is pending, timed out or malformed, without losing prior privacy knowledge", () => {
  const policy = createNativeAdapterProtector({});
  const read = policy.beginNativeRead();
  expect(policy.clean(value)).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  policy.finishNativeRead(read, false);
  expect(policy.observationAvailable()).toBe(false);
  accept(policy, read, receipt(policy, read, [value]));
  expect(policy.observationAvailable()).toBe(false); // Late success cannot finish a timed-out read.
  const next = policy.beginNativeRead();
  expect(accept(policy, next, receipt(policy, next, [42]))).toBe(false);
  policy.finishNativeRead(next, false);
  expect(policy.clean("ordinary text")).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
});
it("never evicts learned values or silently releases later text on capacity overflow", () => {
  const policy = createNativeAdapterProtector({});
  const read = policy.beginNativeRead();
  expect(
    accept(
      policy,
      read,
      receipt(
        policy,
        read,
        Array.from({ length: 128 }, (_, i) => `private-fixture-${i}`),
      ),
    ),
  ).toBe(true);
  policy.finishNativeRead(read, true);
  expect(policy.clean("private-fixture-0")).not.toContain("private-fixture-0");
  const next = policy.beginNativeRead();
  expect(accept(policy, next, receipt(policy, next, [value]))).toBe(false);
  policy.finishNativeRead(next, true);
  expect(policy.observationAvailable()).toBe(false);
  expect(policy.observationIssue()).toBe("native_protection_capacity");
  expect(policy.clean(value)).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  const recovery = policy.beginNativeRead();
  accept(policy, recovery, receipt(policy, recovery, []));
  policy.finishNativeRead(recovery, true);
  expect(policy.observationAvailable()).toBe(false); // Monotonic until disposal, not blind snapshot retry.
});
it("keeps parent native diagnostics count-only across empty/bound facts and policy changes", () => {
  const policy = createNativeAdapterProtector({ selected: value });
  for (const values of [[], [value]]) {
    const read = policy.beginNativeRead();
    accept(policy, read, receipt(policy, read, values));
    policy.finishNativeRead(read, true);
    expect(policy.observationAvailable()).toBe(true);
    expect(policy.diagnosticDetailAllowed()).toBe(false);
    policy.updateSecrets({ selected: value });
    expect(policy.diagnosticDetailAllowed()).toBe(false);
  }
  expect(String(policy.clean(value))).not.toContain(value);
  policy.dispose();
  expect(policy.diagnosticDetailAllowed()).toBe(false);
});

it.each([
  "cc-number",
  "cc-csc",
  "cc-exp",
  "creditCard",
  "Credit Card",
  "newpassword",
  "new-password",
  "current-password",
])("retains historical sensitive semantics for %s", (value) => {
  expect(nativeSensitiveSemantic(value)).toBe(true);
  expect(snapshot(createNativeAdapterProtector({}), line(value))).not.toContain(
    "fictional-generated-private-value",
  );
});

it.each([4096, 4097, 65536])(
  "preserves admitted bound value length %s without charging discovery limits or resending it per read",
  (length) => {
    const bound = "a".repeat(length),
      policy = createNativeAdapterProtector({ selected: bound });
    expect(policy.observationAvailable()).toBe(false);
    expect(policy.clean(bound)).not.toContain(bound);
    expect(policy.readExpression).not.toContain(bound);
    const read = policy.beginNativeRead();
    expect(accept(policy, read, receipt(policy, read, []))).toBe(true);
    policy.finishNativeRead(read, true);
    expect(policy.observationAvailable()).toBe(true);
    expect(policy.clean("Ordinary invoice information")).toBe("Ordinary invoice information");
  },
);
it("keeps the existing large bound set separate from bounded learned state", () => {
  const policy = createNativeAdapterProtector(
    Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `bound${i}`,
        `${String.fromCharCode(65 + i)}${"a".repeat(65535)}`,
      ]),
    ),
  );
  const read = policy.beginNativeRead();
  expect(accept(policy, read, receipt(policy, read))).toBe(true);
  expect(policy.finishNativeRead(read, true)).toBe(true);
  expect(policy.readExpression.length).toBeLessThan(1024);
  expect(policy.clean("Ordinary issue information")).toBe("Ordinary issue information");
});
it("prelearns all result parts before cleaning earlier repeated values", () => {
  const policy = createNativeAdapterProtector({});
  const cleaned = policy.cleanTextContent(
    [
      { type: "text", text: `Earlier generic occurrence ${value}` },
      { type: "text", text: line("Access token") },
    ],
    true,
  );
  expect(JSON.stringify(cleaned)).not.toContain(value);
});
it("redacts a whole YAML multiline control value while preserving following sibling controls", () => {
  const policy = createNativeAdapterProtector({});
  const cleaned = String(
    snapshot(
      policy,
      '- textbox "Access token" [ref=e1]: |\n    private-first-line\n    private-second-line\n- button "Continue" [ref=e2]',
    ),
  );
  expect(cleaned).not.toContain("private-first-line");
  expect(cleaned).not.toContain("private-second-line");
  expect(cleaned).toContain('button "Continue" [ref=e2]');
});
it("cannot admit text after malformed Unicode makes newly learned classification fail", () => {
  const policy = createNativeAdapterProtector({}),
    malformed = "fictional-private-" + String.fromCharCode(0xd800);
  for (const values of [[value, malformed], [malformed]]) {
    const read = policy.beginNativeRead();
    expect(accept(policy, read, receipt(policy, read, values))).toBe(false);
    policy.finishNativeRead(read, true);
    expect(policy.observationAvailable()).toBe(false);
    expect(policy.clean(malformed)).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
    expect(policy.observationIssue()).toBe("native_protection_classification_failed");
  }
});
it("cleans only text content and preserves exact image bytes/envelopes even during unavailable harvest", () => {
  const policy = createNativeAdapterProtector({ selected: "iVBOR" });
  const image = { type: "image", mimeType: "image/png", data: "iVBORfictionalPNGbase64" };
  const content = [image, { type: "text", text: "iVBOR" }];
  const output = policy.cleanTextContent(content, false);
  expect(output[0]).toBe(image);
  expect(output[1]!.text).not.toContain("iVBOR");
  policy.beginNativeRead();
  const unavailable = policy.cleanTextContent(content, false);
  expect(unavailable[0]).toBe(image);
  expect(unavailable[1]!.text).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
});
it("bounds cumulative explicit history without evicting secrets or silently releasing extreme sessions", () => {
  const policy = createNativeAdapterProtector({});
  const baseScriptBytes = policy.script.length;
  for (let i = 0; i < 1000; i++) policy.updateSecrets({ selected: `fictional-bound-history-${i}` });
  const read = policy.beginNativeRead();
  accept(policy, read, receipt(policy, read, []));
  policy.finishNativeRead(read, true);
  expect(policy.observationAvailable()).toBe(false);
  expect(policy.observationIssue()).toBe("native_protection_capacity");
  expect(policy.clean("fictional-bound-history-999")).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  expect(policy.script.length).toBeLessThan(baseScriptBytes + 256 * 100);
  policy.dispose();
  expect(policy.script).not.toContain("fictional-bound-history-");
});
it("admits normal multiple maximum-sized binding batches before an explicit cumulative byte limit", () => {
  const batch = (offset: number) =>
    Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `bound${offset + i}`,
        `${String.fromCharCode(65 + offset + i)}${"a".repeat(65535)}`,
      ]),
    );
  const policy = createNativeAdapterProtector(batch(0));
  policy.updateSecrets(batch(50));
  const read = policy.beginNativeRead();
  accept(policy, read, receipt(policy, read, []));
  policy.finishNativeRead(read, true);
  expect(policy.observationAvailable()).toBe(true);
  expect(policy.readExpression.length).toBeLessThan(1024);
  policy.updateSecrets(batch(100));
  expect(policy.observationAvailable()).toBe(false);
  expect(policy.observationIssue()).toBe("native_protection_capacity");
  expect(policy.script.length).toBeLessThan(9 * 1024 * 1024);
  expect(policy.clean("Ordinary text")).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  policy.dispose();
  expect(policy.script).not.toContain("aaaaaaa");
});
it.each([
  "Private service access credential",
  "Service credential",
  "API credential",
  "Authentication credential",
])("protects qualified %s payloads", (label) => {
  expect(nativeSensitiveSemantic(label)).toBe(true);
  expect(String(snapshot(createNativeAdapterProtector({}), line(label))).includes(value)).toBe(
    false,
  );
});
it.each([
  "Credential name",
  "Credential status",
  "Credential count",
  "Service access credential name",
  "Service access credential status",
  "Password protection",
  "Password policy",
  "Token count",
  "Promotion code for a cart discount",
  "Product stock reference",
])("preserves public credential metadata/business value %s", (label) => {
  const content = line(label, "ordinary-public-value");
  expect(snapshot(createNativeAdapterProtector({}), content)).toBe(content);
});
it("does not reinterpret checkbox/button/setting-selector snapshots as credential payloads", () => {
  const policy = createNativeAdapterProtector({});
  const content =
    '- checkbox "Password protection" [checked] [ref=e1]: on\n- button "Reset password" [ref=e2]: on\n- combobox "Password" [ref=e3]: on\n- text: Collaboration options connected.';
  expect(snapshot(policy, content)).toBe(content);
});
