import { expect, it } from "vitest";
import { nativeClassifyControl, type NativeControlFacts } from "../src/native-control-policy.js";
const table: Array<[string, NativeControlFacts, boolean, boolean, boolean]> = [
  [
    "checkbox caption is state",
    { type: "checkbox", name: "passwordProtection", labels: ["Password protection"] },
    false,
    false,
    false,
  ],
  ["radio caption is state", { type: "radio", name: "access_token" }, false, false, false],
  ["submit is action", { type: "submit", labels: ["Reset password"] }, false, false, false],
  ["button is action", { type: "button", name: "privateToken" }, false, false, false],
  ["explicit checkbox visual intent", { type: "checkbox", explicit: true }, true, false, false],
  ["explicit text payload", { type: "text", explicit: true }, true, true, false],
  [
    "intrinsic password beats role",
    { type: "password", role: "button", labels: ["Password status"] },
    true,
    true,
    false,
  ],
  [
    "autofill beats helper metadata",
    { type: "text", autocomplete: "current-password", labels: ["Password requirements"] },
    true,
    true,
    false,
  ],
  [
    "financial autofill beats helper metadata",
    { type: "number", autocomplete: "cc-number", labels: ["Card number status"] },
    true,
    true,
    false,
  ],
  [
    "strong access identifier",
    { type: "text", name: "access_token", labels: ["Access token requirements"] },
    true,
    true,
    false,
  ],
  [
    "strong API identifier",
    { type: "hidden", id: "api_key", labels: ["API key status"] },
    true,
    true,
    false,
  ],
  [
    "identifier itself is metadata",
    { type: "text", id: "accessTokenName", labels: ["Access token name"] },
    false,
    false,
    false,
  ],
  [
    "weak credential identifier needs labels",
    { type: "text", id: "serviceCredential" },
    false,
    false,
    true,
  ],
  [
    "weak identifier loses to metadata label",
    { type: "text", id: "serviceCredential", labels: ["Service credential name"] },
    false,
    false,
    false,
  ],
  [
    "qualified label wins unrelated help metadata",
    { type: "text", labels: ["Private service access credential", "Credential name"] },
    true,
    true,
    false,
  ],
  [
    "weak identifier no competing label",
    { type: "text", id: "serviceCredential", labels: [] },
    true,
    true,
    false,
  ],
  ["unknown data payload", { type: "text", labels: ["Code"] }, false, false, false],
  [
    "public promotion",
    { type: "text", labels: ["Promotion code for a cart discount"] },
    false,
    false,
    false,
  ],
  [
    "public opaque stock",
    { type: "text", labels: ["Product stock reference"] },
    false,
    false,
    false,
  ],
  [
    "snapshot actual textbox role",
    { role: "textbox", labels: ["Private service access credential"] },
    true,
    true,
    false,
  ],
  ["snapshot actual spinbutton role", { role: "spinbutton", labels: ["CVV"] }, true, true, false],
  [
    "snapshot checkbox has no payload",
    { role: "checkbox", labels: ["Password protection"] },
    false,
    false,
    false,
  ],
  [
    "snapshot selector does not invent editable kind",
    { role: "combobox", labels: ["Password"] },
    false,
    false,
    false,
  ],
  [
    "missing role and kind unknown",
    { labels: ["Private service access credential"] },
    false,
    false,
    false,
  ],
];
it.each(table)("shared control precedence: %s", (_label, facts, mask, learn, needsLabels) => {
  expect(nativeClassifyControl(facts)).toMatchObject({ mask, learn, needsLabels });
});

it.each(["display-name", "slot-a"])(
  "preserves confirmed public relationship metadata at %s",
  (id) => {
    expect(
      nativeClassifyControl({
        type: "text",
        id,
        labels: ["Display name for private access credential"],
      }),
    ).toMatchObject({ mask: false, learn: false, needsLabels: false, source: "metadata" });
  },
);

const publicRelationships = [
  "Display name for private access credential",
  "Display name of private access credential",
  "Friendly label about the service access credential",
  "Name for the API key",
  "Status of your access token",
  "Requirements for the password",
  "Private access credential display name",
  "Service credential friendly label",
  "Access token display name (read-only)",
  "DisplayNameForPrivateAccessCredential",
  "  Display name for private access credential  ",
  "\n  Display name for private access credential\n  ",
  "Display name for private access credential:",
  "Private access credential friendly name (read-only)",
];
it.each(publicRelationships)("metadata is the subject in %s", (label) => {
  expect(
    nativeClassifyControl({ type: "text", id: "serviceCredential", labels: [label] }),
  ).toMatchObject({
    mask: false,
    learn: false,
    source: "metadata",
  });
  expect(nativeClassifyControl({ role: "textbox", labels: [label] })).toMatchObject({
    mask: false,
    learn: false,
  });
});
it.each([
  "Private service access credential",
  "Access token for the account display name",
  "Password for the display name",
  "API key with a friendly name",
  "Private access credential with display name shown separately",
  "Private access credential: display name shown separately",
  "Display name for private access credential then paste the actual token",
  "Display name for private access credential containing actual password",
])("private payload remains the subject in %s", (label) => {
  expect(nativeClassifyControl({ type: "text", labels: [label] })).toMatchObject({
    mask: true,
    learn: true,
  });
  expect(nativeClassifyControl({ role: "textbox", labels: [label] })).toMatchObject({
    mask: true,
    learn: true,
  });
});
it.each([
  { type: "password" },
  { type: "text", autocomplete: "current-password" },
  { type: "number", autocomplete: "cc-number" },
  { type: "text", name: "access_token" },
  { type: "hidden", id: "api_key" },
  { type: "text", explicit: true },
])("metadata cannot declassify strong private facts %j", (facts) => {
  expect(nativeClassifyControl({ ...facts, labels: publicRelationships })).toMatchObject({
    mask: true,
    learn: true,
  });
});
it("a separate private label wins metadata about another control", () => {
  expect(
    nativeClassifyControl({
      type: "text",
      labels: [publicRelationships[0]!, "Private service access credential"],
    }),
  ).toMatchObject({ mask: true, learn: true });
});

it.each(["Recovery credential", "Backup credential"])(
  "recognizes qualified recovery payload: %s",
  (label) => {
    expect(nativeClassifyControl({ type: "text", labels: [label] })).toMatchObject({
      mask: true,
      learn: true,
    });
  },
);
it.each(["Recovery credential name", "Recovery credential status", "Backup credential count"])(
  "preserves qualified recovery metadata: %s",
  (label) => {
    expect(nativeClassifyControl({ type: "text", labels: [label] })).toMatchObject({
      mask: false,
      learn: false,
    });
  },
);
