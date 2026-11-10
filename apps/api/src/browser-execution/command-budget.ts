import type { BrowserCommand } from "@scry/contracts";

/** Operational upper limits, not per-phase timeouts or performance targets.
 * Legacy synchronous replay closure gets a separate finite budget until native
 * encoding is independent. An existing command's selected budget never renews.
 */
export function commandExecutionBudgetMs(kind: BrowserCommand["kind"], tool?: string): number {
  switch (kind) {
    case "browser_tool":
      return tool === "browser_sequence" ? 25_000 : 60_000;
    case "close":
    case "close_for_failure":
      return 900_000;
    case "navigate":
    case "observe":
    case "fill":
    case "click":
    case "press":
    case "capture_dom":
    case "commit":
    case "publish_capture":
    case "discard_capture":
    case "determine":
      return 120_000;
    default: {
      const unsupported: never = kind;
      throw new Error("SCRY_BROWSER_COMMAND_KIND_UNSUPPORTED", { cause: unsupported });
    }
  }
}
