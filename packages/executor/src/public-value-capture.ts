import type { AcquisitionIntent } from "@scry/contracts";
import type { Page } from "playwright";
import { extractProtectedValue } from "./protected-extractor.js";

/** Public generated values remain ordinary execution and never arm the Privacy Gate. */
export async function capturePublicGeneratedValue(page: Page, acquisition: AcquisitionIntent, timeoutMs: number) {
  const result = await extractProtectedValue(page, acquisition, timeoutMs);
  if (!result.value) throw new PublicValueCaptureError("PUBLIC_VALUE_TARGET_UNRESOLVED");
  return { value: result.value, diagnostics: result.diagnostics };
}

export class PublicValueCaptureError extends Error {
  override name = "PublicValueCaptureError";
  constructor(readonly code: string) { super(code); }
}
