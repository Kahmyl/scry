import {
  interactionTargetIntentSchema,
  missionAuthoringSemanticTargetSchema,
  semanticRoleSchema,
  semanticScopeKinds,
} from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { deriveMissionAuthoringTarget } from "../src/adaptive-sessions/mission-authoring-derivation.js";
import { interruptedOperationTruth } from "../src/adaptive-sessions/adaptive-session.repository.js";

describe("protected interaction cross-layer target conformance", () => {
  it.each(semanticScopeKinds)(
    "projects canonical %s scope from authoring into protected grounding",
    (kind) => {
      const semantic = missionAuthoringSemanticTargetSchema.parse({
        concept: `${kind} protected control`,
        role: "button",
        name: "Generate",
        scope: { kind, ...(kind === "page" ? {} : { name: "Protected area" }) },
        exact: true,
      });
      const protectedTarget = deriveMissionAuthoringTarget(
        semantic,
        false,
        "protected_mutation",
        ["focusable", "pointer_activatable"],
      );
      expect(interactionTargetIntentSchema.parse(protectedTarget)).toMatchObject({
        scope: { kind },
        matching: "exact",
        risk: "protected",
      });
    },
  );

  it.each(semanticRoleSchema.options)(
    "shares canonical %s role between authoring and protected grounding",
    (role) => {
      const semantic = missionAuthoringSemanticTargetSchema.parse({
        concept: `${role} protected control`, role, name: "Target", exact: true,
      });
      const protectedTarget = deriveMissionAuthoringTarget(
        semantic, false, "protected_mutation", ["observable"],
      );
      expect(interactionTargetIntentSchema.parse(protectedTarget).preferredEvidence.roles)
        .toEqual([role]);
    },
  );

  it("pins exact references and never broadens protected acquisition matching", () => {
    const reference = `context-control-${"a".repeat(32)}`;
    const semantic = missionAuthoringSemanticTargetSchema.parse({
      concept: "Generate", reference, role: "button", exact: false,
    });
    expect(deriveMissionAuthoringTarget(
      semantic, false, "protected_mutation", ["pointer_activatable"],
    )).toMatchObject({ authoritativeReference: reference, matching: "exact" });
  });

  it.each([
    ["not_dispatched", "not_applied", "ADAPTIVE_OPERATION_INTERRUPTED_BEFORE_DISPATCH"],
    ["dispatching", "unknown", "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN"],
    ["acknowledged", "unknown", "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN"],
  ] as const)("preserves mutation truth for %s", (boundary, mutationOutcome, reasonCode) => {
    expect(interruptedOperationTruth(boundary)).toMatchObject({ mutationOutcome, reasonCode });
  });
});
