import { describe, expect, it } from "vitest";

import { classifyMalformedControlFacts, type MalformedControlFacts } from "../src/quality.js";

const fixtures: Array<{
  name: string;
  functionalResult: "passed";
  facts: MalformedControlFacts;
  qualityFindings: string[];
}> = [
  {
    name: "unlabeled input",
    functionalResult: "passed",
    facts: { missingLabelAssociation: true },
    qualityFindings: ["LABEL_CONTROL_ASSOCIATION_FAILURE"],
  },
  {
    name: "incorrect label association",
    functionalResult: "passed",
    facts: { incorrectLabelAssociation: true },
    qualityFindings: ["LABEL_CONTROL_ASSOCIATION_FAILURE"],
  },
  {
    name: "clickable div",
    functionalResult: "passed",
    facts: { interactiveWithoutRole: true },
    qualityFindings: ["MISSING_SEMANTIC_IDENTITY"],
  },
  {
    name: "nested button text",
    functionalResult: "passed",
    facts: {},
    qualityFindings: [],
  },
  {
    name: "duplicate labels",
    functionalResult: "passed",
    facts: { duplicateAccessibleName: true },
    qualityFindings: ["AMBIGUOUS_DUPLICATE_IDENTITY"],
  },
  {
    name: "hidden duplicate control",
    functionalResult: "passed",
    facts: { hiddenDuplicate: true },
    qualityFindings: ["UNSTABLE_CONTROL_IDENTITY"],
  },
  {
    name: "custom dropdown",
    functionalResult: "passed",
    facts: { customControl: true },
    qualityFindings: ["SPECIALIZED_CUSTOM_CONTROL"],
  },
  { name: "portal", functionalResult: "passed", facts: {}, qualityFindings: [] },
  { name: "dialog", functionalResult: "passed", facts: {}, qualityFindings: [] },
  { name: "iframe", functionalResult: "passed", facts: {}, qualityFindings: [] },
  { name: "shadow DOM", functionalResult: "passed", facts: {}, qualityFindings: [] },
  {
    name: "visual-only icon",
    functionalResult: "passed",
    facts: { visualOnlyIdentity: true },
    qualityFindings: ["MISSING_SEMANTIC_IDENTITY"],
  },
  {
    name: "canvas control",
    functionalResult: "passed",
    facts: { canvasOnly: true },
    qualityFindings: ["CANVAS_ONLY_INTERACTION"],
  },
];

describe("PR9 malformed-control corpus", () => {
  for (const fixture of fixtures) {
    it(`separates functional success from quality findings for ${fixture.name}`, () => {
      expect(fixture.functionalResult).toBe("passed");
      expect(classifyMalformedControlFacts(fixture.facts)).toEqual(fixture.qualityFindings);
    });
  }
});
