import type { CandidateEvidence, InteractionTargetIntent } from "@scry/contracts";
import type { ObservedControl } from "./grounding.js";

export type PraxisVisualAnchor = {
  text: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
};
type Context = {
  intent: InteractionTargetIntent;
  control: ObservedControl;
  anchors: readonly PraxisVisualAnchor[];
};
type Provider = {
  id: string;
  version: 1;
  privacy: "public_dom" | "accessibility" | "visual";
  cost: "constant" | "low" | "high";
  correlation: string;
  collect(context: Context): CandidateEvidence[];
};

export const praxisEvidenceProviders: readonly Provider[] = [
  {
    id: "native-control",
    version: 1,
    privacy: "public_dom",
    cost: "constant",
    correlation: "native-control",
    collect: ({ intent, control }) => {
      const similarity = similarities(intent.preferredEvidence.inputTypes, control.inputType);
      return control.tag || control.inputType
        ? [
            {
              family: "native_control",
              signal: "native-kind",
              score: Math.max(
                similarity,
                control.capabilities.canAcceptText || control.capabilities.canToggle ? 0.8 : 0.55,
              ),
              correlationGroup: "native-control",
            },
          ]
        : [];
    },
  },
  {
    id: "computed-accessibility",
    version: 1,
    privacy: "accessibility",
    cost: "low",
    correlation: "accessible-identity",
    collect: ({ intent, control }) => {
      const p = intent.preferredEvidence;
      const role = similarities(p.roles, control.accessibilityRole || control.role);
      const identity = Math.max(
        similarities(p.names, control.accessibilityName || control.name),
        Math.max(
          0,
          ...p.labels.flatMap((expected) =>
            control.labels.map((actual) => match(expected, actual)),
          ),
        ),
      );
      const score = identity ? Math.max(identity, role * 0.85) : 0;
      return score
        ? [
            {
              family: "accessibility",
              signal: "computed-accessibility",
              score,
              correlationGroup: "accessible-identity",
            },
          ]
        : [];
    },
  },
  {
    id: "textual-identity",
    version: 1,
    privacy: "public_dom",
    cost: "low",
    correlation: "visible-identity",
    collect: ({ intent, control }) => {
      const p = intent.preferredEvidence;
      const score = Math.max(
        similarities(p.names, control.name),
        similarities(p.names, control.text),
        similarities(p.labels, control.context),
        similarities(p.placeholders, control.placeholder),
        p.expectedText ? match(p.expectedText, control.text) : 0,
      );
      return score
        ? [
            {
              family: "textual",
              signal: "textual-identity",
              score,
              correlationGroup: "visible-identity",
            },
          ]
        : [];
    },
  },
  {
    id: "structural-relationship",
    version: 1,
    privacy: "public_dom",
    cost: "constant",
    correlation: "scope",
    collect: () => [
      { family: "structural", signal: "scope-membership", score: 0.75, correlationGroup: "scope" },
    ],
  },
  {
    id: "geometry-visual",
    version: 1,
    privacy: "visual",
    cost: "high",
    correlation: "visual-anchor",
    collect: ({ control, anchors }) =>
      anchors.flatMap((anchor) => {
        const distance = geometryDistance(anchor.bounds, control.bounds);
        return distance < 240
          ? [
              {
                family: "visual" as const,
                signal: "nearby-anchor",
                score: Math.max(0, anchor.confidence * (1 - distance / 300)),
                correlationGroup: `anchor:${normalize(anchor.text)}`,
              },
            ]
          : [];
      }),
  },
] as const;

export function collectPraxisEvidence(
  intent: InteractionTargetIntent,
  control: ObservedControl,
  anchors: readonly PraxisVisualAnchor[],
) {
  const context = { intent, control, anchors };
  return praxisEvidenceProviders.flatMap((provider) => provider.collect(context));
}

function similarities(expected: string[], actual: string) {
  return Math.max(0, ...expected.map((item) => match(item, actual)));
}
function geometryDistance(a: PraxisVisualAnchor["bounds"], b: PraxisVisualAnchor["bounds"]) {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
}
function match(expected: string, actual: string) {
  if (!expected || !actual) return 0;
  const e = normalize(expected),
    a = normalize(actual);
  return e === a ? 1 : a.includes(e) || e.includes(a) ? 0.72 : 0;
}
function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
