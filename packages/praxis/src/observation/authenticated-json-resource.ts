import type { Response } from "playwright";

import {
  closePraxisBrowserResources,
  openPraxisBrowserSession,
} from "../lifecycle/browser-session.js";
import { navigateAndWaitNative } from "../lifecycle/navigation.js";
import { fillReferencedTarget } from "../interaction/fill.js";
import { observeTargetReference } from "../references/target-reference.js";

export type AuthenticatedJsonResourceObservationInput = {
  browserChannel?: string;
  allowedOrigins: string[];
  trustedScriptOrigins: string[];
  login: {
    url: string;
    fields: Array<{ placeholder: string; value: string }>;
    submitName: string;
  };
  resource: {
    url: string;
    readiness: { role: "button"; name: string };
    responseOrigins: string[];
    responsePath: string;
  };
  timeoutMs: number;
};

/** Browser mechanics only. Provider adapters own URLs, fields, and response semantics. */
export async function observeAuthenticatedJsonResource(
  input: AuthenticatedJsonResourceObservationInput,
): Promise<{ bodies: unknown[] }> {
  const allowed = new Set(input.allowedOrigins);
  for (const url of [input.login.url, input.resource.url]) {
    if (!allowed.has(new URL(url).origin)) throw new Error("RESOURCE_OBSERVATION_ORIGIN_REFUSED");
  }
  const session = await openPraxisBrowserSession({
    ...(input.browserChannel ? { browserChannel: input.browserChannel } : {}),
  });
  try {
    await navigateAndWaitNative(
      session.page,
      input.login.url,
      input.allowedOrigins,
      input.timeoutMs,
      input.trustedScriptOrigins,
    );
    for (const field of input.login.fields) {
      const reference = await observeTargetReference(
        session.page,
        session.page.getByPlaceholder(field.placeholder, { exact: true }),
      );
      try {
        await fillReferencedTarget(reference, field.value, { timeoutMs: input.timeoutMs });
      } finally {
        await reference.dispose();
      }
    }
    const submit = await observeTargetReference(
      session.page,
      session.page.getByRole("button", { name: input.login.submitName, exact: true }),
    );
    try {
      await submit.assertCurrent();
      await submit.element().click({ timeout: input.timeoutMs, noWaitAfter: true });
    } finally {
      await submit.dispose();
    }
    const loginPath = new URL(input.login.url).pathname;
    await session.page.waitForURL((url) => allowed.has(url.origin) && url.pathname !== loginPath, {
      timeout: input.timeoutMs,
    });

    const captured: Array<Promise<unknown | undefined>> = [];
    const responseOrigins = new Set(input.resource.responseOrigins);
    const listener = (response: Response) => {
      const responseUrl = new URL(response.url());
      if (
        !responseOrigins.has(responseUrl.origin) ||
        responseUrl.pathname !== input.resource.responsePath
      )
        return;
      if (
        response.request().method() !== "GET" ||
        response.status() < 200 ||
        response.status() >= 300
      )
        return;
      captured.push(response.json().catch(() => undefined));
    };
    session.page.on("response", listener);
    try {
      await navigateAndWaitNative(
        session.page,
        input.resource.url,
        input.allowedOrigins,
        input.timeoutMs,
        input.trustedScriptOrigins,
      );
      await session.page
        .getByRole(input.resource.readiness.role, {
          name: input.resource.readiness.name,
          exact: true,
        })
        .waitFor({ state: "visible", timeout: input.timeoutMs });
      await session.page.waitForTimeout(750);
    } finally {
      session.page.off("response", listener);
    }
    return { bodies: (await Promise.all(captured)).filter((body) => body !== undefined) };
  } finally {
    for (const field of input.login.fields) field.value = "";
    await closePraxisBrowserResources(session.context, session.browser);
  }
}
