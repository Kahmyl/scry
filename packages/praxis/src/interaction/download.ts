import type { Download } from "playwright";

import { clickReferencedTarget } from "./click.js";
import type { PraxisTargetReference } from "../references/target-reference.js";

export async function downloadFromReferencedTarget(
  reference: PraxisTargetReference,
  options: { timeoutMs?: number } = {},
): Promise<Download> {
  const pending = reference
    .page()
    .waitForEvent(
      "download",
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs },
    );
  const [download] = await Promise.all([pending, clickReferencedTarget(reference, options)]);
  return download;
}
