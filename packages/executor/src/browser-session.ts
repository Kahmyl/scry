import type { Browser, BrowserContext, Page } from "playwright";
import type { ContextProvenance } from "@scry/contracts";
import type { VeilClipboardCollector } from "@scry/veil";

const transitions: Record<ContextProvenance, ContextProvenance[]> = {
  safe: ["safe_parked", "destroyed"],
  safe_parked: ["safe", "destroyed"],
  protected: ["tainted", "destroyed"],
  tainted: ["destroyed"],
  destroyed: [],
  restored_pending_verification: ["restored_safe", "destroyed"],
  restored_safe: ["safe_parked", "destroyed"],
};

export class BrowserSessionProvenance {
  constructor(
    readonly contextId: string,
    private current: ContextProvenance,
  ) {}
  value() {
    return this.current;
  }
  transition(next: ContextProvenance) {
    if (!transitions[this.current].includes(next))
      throw new Error(`CONTEXT_PROVENANCE_TRANSITION_REJECTED:${this.current}:${next}`);
    this.current = next;
  }
  canProduceEvidence() {
    return this.current === "safe" || this.current === "restored_safe";
  }
}

export type SafeBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  provenance: BrowserSessionProvenance;
};

/** Deliberately contains no evidence or artifact interfaces. */
export type ProtectedBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  provenance: BrowserSessionProvenance;
  clipboardCollector: VeilClipboardCollector;
  destroy(): Promise<"destroyed" | "force_terminated">;
};
