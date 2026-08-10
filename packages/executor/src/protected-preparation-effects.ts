export type PassivePreparationEffectCategory = "telemetry" | "platform";

export function classifyPassivePreparationRequest(input: {
  method: string;
  url: URL;
  allowedOrigins: readonly string[];
}): PassivePreparationEffectCategory | undefined {
  if (input.method !== "POST") return undefined;
  const { hostname, pathname, origin } = input.url;

  if (input.allowedOrigins.includes(origin) && pathname === "/cdn-cgi/rum")
    return "telemetry";

  if (
    (hostname === "ingest.sentry.io" || /\.ingest\.[a-z0-9-]+\.sentry\.io$/i.test(hostname)) &&
    /^\/api\/\d+\/envelope\/$/.test(pathname)
  ) return "telemetry";

  if (
    (hostname === "m.stripe.com" && pathname === "/6") ||
    (hostname === "r.stripe.com" && pathname === "/b")
  ) return "platform";

  return undefined;
}
