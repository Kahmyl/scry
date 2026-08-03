import type { Page } from "playwright";
import { compileVeilPolicy } from "@scry/veil";
import { VeilAuthority } from "@scry/veil";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { executePraxisConsumer, type PraxisConsumerInput } from "@scry/praxis";

const pageAuthorities = new WeakMap<Page, ReturnType<typeof createPraxisCampaignVeil>>();
let contextSequence = 0;

/** Campaign-only consumer that explicitly installs exactly one authority per page. */
export function executePraxisCampaignConsumer(input: PraxisConsumerInput) {
  let veil = pageAuthorities.get(input.page);
  if (!veil) {
    // Authority follows the actual campaign document, not the request's
    // declared origin allow-list (which adversarial scenarios intentionally corrupt).
    const documentOrigin = new URL(input.page.url()).origin;
    veil = createPraxisCampaignVeil("praxis-campaign", [documentOrigin]);
    veil.register(input.page, `page-${++contextSequence}`);
    pageAuthorities.set(input.page, veil);
  }
  return executePraxisConsumer(input);
}

/** Explicit campaign composition root. Production code never imports this helper. */
export function createPraxisCampaignVeil(campaignId: string, origins: readonly string[]) {
  const authority = new VeilAuthority(
    compileVeilPolicy({
      profile: "balanced",
      allowedOrigins: [...new Set(origins.map((value) => new URL(value).origin))],
      leaseTtlMs: 60_000,
    }),
  );
  return {
    authority,
    register(page: Page, contextId: string) {
      return registerPraxisVeilAuthority(page, {
        authority,
        userId: `${campaignId}-user`,
        environmentId: "campaign",
        browserContextId: `${campaignId}-${contextId}`,
      });
    },
  };
}
