import { createHash } from "node:crypto";

import {
  VEIL_CONTRACT_VERSION,
  veilPolicyPreferencesSchema,
  veilPolicySnapshotSchema,
  type VeilPolicyControls,
  type VeilPolicyPreferences,
  type VeilPolicySnapshot,
  type VeilProfile,
  type ExecutionPolicy,
} from "@scry/contracts";

const SAFETY_FLOOR = Object.freeze({
  maskSensitiveVisuals: true,
  sanitizeStructuredEvidence: true,
  quarantineUnknown: true,
} as const);

const PROFILES: Readonly<Record<Exclude<VeilProfile, "custom">, Readonly<VeilPolicyControls>>> = Object.freeze({
  balanced: Object.freeze({
    screenshots: true, video: true, dom: true, accessibility: true, diagnostics: true,
    network: true, trace: true, clipboard: false, downloads: false, ...SAFETY_FLOOR,
  }),
  private: Object.freeze({
    screenshots: true, video: false, dom: false, accessibility: true, diagnostics: false,
    network: false, trace: false, clipboard: false, downloads: false, ...SAFETY_FLOOR,
  }),
  minimal_capture: Object.freeze({
    screenshots: false, video: false, dom: false, accessibility: false, diagnostics: false,
    network: false, trace: false, clipboard: false, downloads: false, ...SAFETY_FLOOR,
  }),
});

/** Compile one or more preference layers. Later layers cannot loosen earlier restrictions. */
export function compileVeilPolicy(input: VeilPolicyPreferences | readonly VeilPolicyPreferences[]): VeilPolicySnapshot {
  const layers = (Array.isArray(input) ? input : [input]).map((layer) => veilPolicyPreferencesSchema.parse(layer));
  if (layers.length === 0) throw new VeilPolicyCompilationError("VEIL_POLICY_EMPTY", "At least one policy layer is required");

  const origins = layers.slice(1).reduce(
    (allowed, layer) => allowed.filter((origin) => layer.allowedOrigins.includes(origin)),
    [...layers[0]!.allowedOrigins],
  );
  if (origins.length === 0) throw new VeilPolicyCompilationError("VEIL_POLICY_NO_COMMON_ORIGIN", "Policy layers have no common allowed origin");

  const controls = layers.map(resolveControls).reduce((effective, layer) => intersectControls(effective, layer));
  const profile = effectiveProfile(layers.map(({ profile }) => profile));
  const unsigned = {
    schemaVersion: VEIL_CONTRACT_VERSION,
    profile,
    allowedOrigins: [...new Set(origins)].sort(),
    controls,
    leaseTtlMs: Math.min(...layers.map(({ leaseTtlMs }) => leaseTtlMs)),
  } as const;
  const snapshot = veilPolicySnapshotSchema.parse({ ...unsigned, digest: sha256(stableJson(unsigned)) });
  return deepFreeze(snapshot);
}

/** Compatibility entry point for callers that only have the existing execution policy. */
export function compileDefaultVeilPolicy(policy: Pick<ExecutionPolicy, "allowedOrigins" | "allowDownloads">): VeilPolicySnapshot {
  return compileVeilPolicy({
    profile: "balanced",
    allowedOrigins: policy.allowedOrigins,
    controls: { downloads: policy.allowDownloads },
  });
}

export class VeilPolicyCompilationError extends Error {
  override name = "VeilPolicyCompilationError";
  constructor(readonly code: "VEIL_POLICY_EMPTY" | "VEIL_POLICY_NO_COMMON_ORIGIN", message: string) { super(message); }
}

export function veilPolicyDigest(value: Omit<VeilPolicySnapshot, "digest">): string {
  return sha256(stableJson(value));
}

function resolveControls(layer: ReturnType<typeof veilPolicyPreferencesSchema.parse>): VeilPolicyControls {
  const baseline = layer.profile === "custom" ? PROFILES.balanced : PROFILES[layer.profile];
  return {
    screenshots: layer.controls.screenshots ?? baseline.screenshots,
    video: layer.controls.video ?? baseline.video,
    dom: layer.controls.dom ?? baseline.dom,
    accessibility: layer.controls.accessibility ?? baseline.accessibility,
    diagnostics: layer.controls.diagnostics ?? baseline.diagnostics,
    network: layer.controls.network ?? baseline.network,
    trace: layer.controls.trace ?? baseline.trace,
    clipboard: layer.controls.clipboard ?? baseline.clipboard,
    downloads: layer.controls.downloads ?? baseline.downloads,
    ...SAFETY_FLOOR,
  };
}

function intersectControls(left: VeilPolicyControls, right: VeilPolicyControls): VeilPolicyControls {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key as keyof VeilPolicyControls] && right[key as keyof VeilPolicyControls]])) as VeilPolicyControls;
}

function effectiveProfile(profiles: VeilProfile[]): VeilProfile {
  if (profiles.includes("custom")) return "custom";
  if (profiles.includes("minimal_capture")) return "minimal_capture";
  if (profiles.includes("private")) return "private";
  return "balanced";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export { SAFETY_FLOOR as VEIL_SAFETY_FLOOR, PROFILES as VEIL_PROFILE_DEFAULTS };
