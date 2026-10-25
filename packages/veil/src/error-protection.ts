import { recordingFailureCodes } from "@scry/contracts";
import { admittedBrowserFailureCodes } from "./error-codes.js";

const uuid = "[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}";
const identifiers = new RegExp(`^${uuid}(?:,${uuid}){0,99}$`, "u");
const identifierCodes = new Set([
  "SCRY_BROWSER_CAPTURES_UNSETTLED",
  "SCRY_BROWSER_CAPTURE_UNSETTLED",
  "SCRY_BROWSER_EFFECT_OUTCOME_PENDING",
  "SCRY_BROWSER_EFFECT_UNRESOLVED",
  "SCRY_BROWSER_SESSION_INCOMPLETE",
]);
function admitted(error: unknown): string | undefined {
  let raw: unknown;
  try {
    raw = error instanceof Error ? error.message : error;
  } catch {
    return;
  }
  if (typeof raw !== "string" || raw.length > 4000) return;
  if (admittedBrowserFailureCodes.has(raw)) return raw;
  const colon = raw.indexOf(":");
  if (colon < 0) return;
  const code = raw.slice(0, colon),
    detail = raw.slice(colon + 1);
  if (identifierCodes.has(code) && identifiers.test(detail)) return raw;
  if (
    code === "SCRY_BROWSER_RECORDER_FAILED" &&
    recordingFailureCodes.some((value) => value === detail)
  )
    return raw;
}

/** Finite failure metadata only. Arbitrary diagnostic values are not safe codes. */
export function publicBrowserErrorCode(error: unknown): string | undefined {
  const code = admitted(error);
  return code?.startsWith("SCRY_BROWSER_") && !code.includes(":") ? code : undefined;
}

export function finalizationBrowserErrorCode(error: unknown): string {
  const code = admitted(error);
  return code?.startsWith("SCRY_BROWSER_") ? code : "SCRY_BROWSER_FINALIZATION_FAILED";
}

export function storedBrowserFailureCode(error: unknown): string {
  return admitted(error) ?? "SCRY_BROWSER_COMMAND_FAILED";
}
