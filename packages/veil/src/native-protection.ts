import { nativeControlPolicySource, nativeControlLimits } from "./native-control-policy.js";
import { readFileSync } from "node:fs";
import type { NativeCaptureEpoch } from "@scry/contracts";

// Load plain browser JavaScript, never a server-transformed Function.toString().
// Server transpilers may inject helpers that do not exist in the browser world.
const runtime = readFileSync(new URL("./native-mask-runtime.js", import.meta.url), "utf8");
export function nativeProtectionScript(
  values: readonly string[],
  options: {
    learned?: readonly string[];
    policyGeneration?: number;
    captureEpoch?: NativeCaptureEpoch;
    limited?: boolean;
  } = {},
): string {
  const retained = new Set<string>();
  let bytes = 0,
    limited = false;
  for (const value of values) {
    if (!value || retained.has(value)) continue;
    if (
      retained.size >= nativeControlLimits.boundValues ||
      bytes + value.length * 2 > nativeControlLimits.boundBytes
    ) {
      limited = true;
      break;
    }
    retained.add(value);
    bytes += value.length * 2;
  }
  return (
    "(() => {\n" +
    nativeControlPolicySource +
    "\n" +
    runtime +
    "\ninstallNativePrivacyGraph(" +
    JSON.stringify([...retained]) +
    "," +
    JSON.stringify({
      roots: 512,
      initialLearned: options.learned ?? [],
      policyGeneration: options.policyGeneration ?? 1,
      captureEpoch: options.captureEpoch,
      limited: limited || options.limited === true,
    }) +
    ");\n})()"
  );
}
