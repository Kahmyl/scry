import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { nativeControlPolicySource } from "../src/native-control-policy.js";
const decide = runInNewContext(nativeControlPolicySource + "\nnativeAdjacentFieldLabel");
const base = {
  hasCanonicalName: false,
  sameParent: true,
  pureTextLabel: true,
  labelTag: "p",
  atomicTarget: true,
  value: "fictional_opaque_value",
  presentation: true,
  label: "Recovery credential",
};
const rows = [
  ["r4-01 adjacent recovery", {}, true],
  ["r4-05 adjacent access", { label: "Access credential" }, true],
  ["API key", { label: "Generated API key" }, true],
  ["private token", { label: "Private token" }, true],
  ["whitespace formatting", { label: "\n Recovery credential: \n" }, true],
  ["readonly input", { control: true, type: "text", readonly: true }, true],
  ["editable input", { control: true, type: "text", readonly: false }, false],
  ["checkbox", { control: true, type: "checkbox", readonly: true }, false],
  ["explicit own public metadata", { hasCanonicalName: true }, false],
  ["own metadata identifier", { ownMetadata: true }, false],
  ["hidden label", { labelHidden: true }, false],
  ["metadata noun", { label: "Recovery credential name" }, false],
  ["metadata head", { label: "Display name for private access credential" }, false],
  ["prose prefix", { label: "Please use your access token" }, false],
  ["prose suffix", { label: "Access token for account display name" }, false],
  ["ambiguous key", { label: "Key" }, false],
  ["ambiguous token", { label: "Token" }, false],
  ["ambient heading", { labelTag: "h2" }, false],
  ["action caption", { labelTag: "button" }, false],
  ["bound label for another field", { labelTag: "label", labelHasFor: true }, false],
  ["independent wrapper", { sameParent: false }, false],
  ["independent descendants", { atomicTarget: false }, false],
  ["explanatory target prose", { value: "Ordinary text explains this setting." }, false],
  ["target action", { interactiveTarget: true }, false],
  ["target contenteditable", { editable: true }, false],
  ["label rolebutton", { labelInteractive: true }, false],
  ["label explicit unrelated name", { labelHasExplicitName: true }, false],
  ["label markup", { pureTextLabel: false }, false],
  ["label oversize", { label: "Recovery credential" + " ".repeat(8193) }, false],
  ["value oversize", { value: "x".repeat(4097) }, false],
];

for (const [name, facts, expected] of rows)
  it(String(name), () => {
    expect(!!decide({ ...base, ...(facts as object) })).toBe(expected);
  });
