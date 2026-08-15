import type { Page } from "playwright";

const fencedPages = new WeakSet<Page>();
const blockedScriptOriginsByPage = new WeakMap<Page, Set<string>>();

export function blockedThirdPartyScriptOrigins(page: Page) {
  return [...(blockedScriptOriginsByPage.get(page) ?? [])];
}

export async function navigateAndWaitNative(
  page: Page,
  url: string,
  allowedOrigins: Iterable<string>,
  timeout = 30_000,
  trustedScriptOrigins: Iterable<string> = [],
) {
  const allowed = new Set(allowedOrigins);
  requireAllowedOrigin(url, allowed);
  await installThirdPartyScriptFence(page, new Set([...allowed, ...trustedScriptOrigins]));
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new NativeNavigationError("NATIVE_NAVIGATION_TIMEOUT");
    }
    throw new NativeNavigationError("NATIVE_NAVIGATION_FAILED");
  }
  requireAllowedOrigin(page.url(), allowed);
  await waitForDocumentSurface(page, timeout);
}

export async function waitForDocumentSurface(page: Page, timeout: number) {
  try {
    await page
      .locator(
        "body,form,main,dialog,h1,h2,h3,button,a,input,textarea,select,[role=dialog],[role=heading],[role=button],[role=link],[role=tab]",
      )
      .first()
      .waitFor({ state: "visible", timeout });
  } catch {
    throw new NativeNavigationError("NATIVE_DOCUMENT_SURFACE_NOT_READY");
  }
}

export function gotoPraxisPage(
  page: Page,
  url: string,
  options: Parameters<Page["goto"]>[1] = {},
) {
  return page.goto(url, options);
}

export function reloadPraxisPage(
  page: Page,
  options: Parameters<Page["reload"]>[0] = {},
) {
  return page.reload(options);
}

export function waitForPraxisLoadState(
  page: Page,
  state: Parameters<Page["waitForLoadState"]>[0],
  options: Parameters<Page["waitForLoadState"]>[1] = {},
) {
  return page.waitForLoadState(state, options);
}

export function waitForPraxisURL(
  page: Page,
  url: Parameters<Page["waitForURL"]>[0],
  options: Parameters<Page["waitForURL"]>[1] = {},
) {
  return page.waitForURL(url, options);
}

export async function installThirdPartyScriptFence(page: Page, allowedOrigins: Set<string>) {
  if (fencedPages.has(page)) return;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.resourceType() !== "script") return route.continue();
    try {
      const origin = new URL(request.url()).origin;
      if (!allowedOrigins.has(origin)) {
        const blocked = blockedScriptOriginsByPage.get(page) ?? new Set<string>();
        blocked.add(origin);
        blockedScriptOriginsByPage.set(page, blocked);
        return route.abort("blockedbyclient");
      }
    } catch {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  fencedPages.add(page);
}

class NativeNavigationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requireAllowedOrigin(value: string, allowed: Set<string>) {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new NativeNavigationError("NATIVE_URL_INVALID");
  }
  if (!allowed.has(origin)) throw new NativeNavigationError("NATIVE_ORIGIN_NOT_ALLOWED");
}
