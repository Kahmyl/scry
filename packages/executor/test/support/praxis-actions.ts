import type { InteractionTargetIntent, PraxisOperation } from "@scry/contracts";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import type { Page } from "playwright";

import { executePraxisConsumer, PraxisConsumerError } from "@scry/praxis";
import { registerPraxisVeilAuthority } from "@scry/praxis";

let ordinal = 0;

export async function clickPraxisTarget(
  page: Page,
  intent: InteractionTargetIntent,
  options: { timeout?: number } = {},
) {
  return execute(page, intent, { type: "activate" }, undefined, options.timeout);
}

export async function fillPraxisTarget(
  page: Page,
  intent: InteractionTargetIntent,
  value: string,
  options: { timeout?: number } = {},
) {
  return execute(
    page,
    intent,
    {
      type: "enter_text",
      input: {
        reference: "value",
        classification:
          intent.risk === "credential" || intent.risk === "authentication"
            ? "known_secret"
            : "public",
      },
    },
    value,
    options.timeout,
  );
}

export async function selectPraxisTarget(
  page: Page,
  intent: InteractionTargetIntent,
  value: string,
  options: { timeout?: number } = {},
) {
  return execute(
    page,
    intent,
    { type: "select_option", input: { reference: "value", classification: "public" } },
    value,
    options.timeout,
  );
}

export async function checkPraxisTarget(
  page: Page,
  intent: InteractionTargetIntent,
  checked: boolean,
  options: { timeout?: number } = {},
) {
  return execute(page, intent, { type: "set_checked", checked }, undefined, options.timeout);
}

async function execute(
  page: Page,
  intent: InteractionTargetIntent,
  operation: PraxisOperation,
  value?: string,
  timeout = 2_000,
) {
  const origin = pageOrigin(page);
  const unregister = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
    ),
    userId: "praxis-characterization",
    environmentId: "test",
    browserContextId: `context-${++ordinal}`,
  });
  try {
    const result = await executePraxisConsumer({
      page,
      intent,
      operation,
      context: { channel: "action", ordinal, allowedOrigins: [origin], timeoutMs: timeout },
      signal: new AbortController().signal,
      ...(value === undefined ? {} : { resolveInput: async () => value }),
    });
    if (result.status !== "succeeded")
      throw Object.assign(new PraxisConsumerError(result), { code: result.code });
    return {
      adapter: result.resolution.strategy,
      diagnostic: { selectedFingerprint: result.resolution.target },
      result,
    };
  } finally {
    unregister();
  }
}

function pageOrigin(page: Page) {
  try {
    const origin = new URL(page.url()).origin;
    if (origin !== "null") return origin;
  } catch {
    /* use test origin */
  }
  return "https://scry.invalid";
}
