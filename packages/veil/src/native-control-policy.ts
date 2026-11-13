export type NativeControlFacts = Readonly<{
  type?: string;
  role?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  labels?: readonly string[];
  explicit?: boolean;
}>;
export type NativeControlDecision = Readonly<{
  mask: boolean;
  learn: boolean;
  needsLabels: boolean;
  source:
    | "explicit"
    | "nonpayload"
    | "intrinsic"
    | "private_identifier"
    | "private_label"
    | "metadata"
    | "weak_identifier"
    | "unknown";
}>;
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export const nativeControlPolicySource = readFileSync(
  new URL("./native-control-policy.browser.js", import.meta.url),
  "utf8",
);
// One literal source of semantic decisions; no transformed Function.toString().
const policy = runInNewContext(
  nativeControlPolicySource +
    "\n({ semantic: nativeSensitiveSemantic, payload: nativePayloadControl, metadata: nativePublicMetadata, classify: nativeClassifyControl, limits: nativeControlLimits })",
) as {
  semantic: (value: string) => boolean;
  payload: (type: string, role: string) => boolean;
  metadata: (value: string) => boolean;
  classify: (facts: NativeControlFacts) => NativeControlDecision;
  limits: Readonly<{
    boundValues: number;
    boundBytes: number;
    learnedValues: number;
    learnedBytes: number;
    learnedLength: number;
    controls: number;
    labels: number;
    semanticLength: number;
  }>;
};
export const nativeSensitiveSemantic = policy.semantic;
export const nativePayloadControl = policy.payload;
export const nativePublicMetadata = policy.metadata;
export const nativeControlLimits = policy.limits;

export const nativeClassifyControl = policy.classify;
